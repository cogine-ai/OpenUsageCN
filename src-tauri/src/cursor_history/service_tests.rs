use std::sync::Arc;

use super::*;

struct ServiceCredentials;

impl CredentialLeasePort for ServiceCredentials {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError> {
        Ok(CredentialLease::new(
            request.provider_id.to_string(),
            request.account_id.to_string(),
            "generation-12".to_string(),
            vec![CredentialCandidate::new(
                "session".to_string(),
                SecretCookie::new("secret-cookie".to_string()),
            )],
        ))
    }

    fn identity_matches(
        &self,
        _lease: &CredentialLease,
        subject: &str,
    ) -> Result<bool, HistoryError> {
        Ok(subject == "bound-subject")
    }

    fn is_current(&self, _lease: &CredentialLease) -> bool {
        true
    }

    fn with_current_lease(
        &self,
        _lease: &CredentialLease,
        operation: &mut dyn FnMut() -> Result<(), HistoryError>,
    ) -> Result<(), HistoryError> {
        operation()
    }
}

struct FailingPageTransport;

impl HistoryTransport for FailingPageTransport {
    fn authenticate(
        &self,
        _candidate: &CredentialCandidate,
        _correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        Ok(AuthOutcome::Authenticated(AuthIdentity::new(
            "bound-subject".to_string(),
        )))
    }

    fn fetch_page(
        &self,
        _candidate: &CredentialCandidate,
        _request: &PageRequest,
        _correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        Err(TransportError::Network)
    }
}

struct SuccessfulPageTransport;

impl HistoryTransport for SuccessfulPageTransport {
    fn authenticate(
        &self,
        _candidate: &CredentialCandidate,
        _correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        Ok(AuthOutcome::Authenticated(AuthIdentity::new(
            "bound-subject".to_string(),
        )))
    }

    fn fetch_page(
        &self,
        _candidate: &CredentialCandidate,
        request: &PageRequest,
        _correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        Ok(ScriptedPage {
            page: request.page,
            events: vec![ScriptedEvent {
                timestamp_ms: RawNumber::Integer(1_799_999_999_000),
                model_name: "raw-model".to_string(),
                token_usage: Some(ScriptedTokenUsage {
                    input_tokens: RawNumber::Integer(10),
                    output_tokens: RawNumber::Integer(20),
                    cache_write_tokens: RawNumber::Integer(30),
                    cache_read_tokens: RawNumber::Integer(40),
                    total_cents: RawNumber::Decimal(25.0),
                }),
                charged_cents: RawNumber::Decimal(50.0),
                owning_user: Some("must-not-persist".to_string()),
                owning_team: Some("must-not-persist".to_string()),
            }],
            total_usage_events_count: Some(1),
        })
    }
}

struct CommitRejectedCredentials;

impl CredentialLeasePort for CommitRejectedCredentials {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError> {
        ServiceCredentials.acquire(request)
    }

    fn identity_matches(
        &self,
        lease: &CredentialLease,
        subject: &str,
    ) -> Result<bool, HistoryError> {
        ServiceCredentials.identity_matches(lease, subject)
    }

    fn is_current(&self, _lease: &CredentialLease) -> bool {
        true
    }

    fn with_current_lease(
        &self,
        _lease: &CredentialLease,
        _operation: &mut dyn FnMut() -> Result<(), HistoryError>,
    ) -> Result<(), HistoryError> {
        Err(HistoryError::CredentialLeaseChanged)
    }
}

#[test]
fn failed_refresh_returns_and_preserves_the_previous_complete_snapshot() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-service-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let previous = super::store_tests::complete_history("account-a", 1_700_000_000_001);
    store
        .save("cursor", "account-a", &previous)
        .expect("seed previous snapshot");
    let service = HistoryService::new(
        Arc::new(ServiceCredentials),
        Arc::new(FailingPageTransport),
        store.clone(),
        HistoryScheduler::isolated_for_test(),
    );

    let refresh = service
        .refresh(HistoryDemand {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            now_ms: 1_800_000_000_000,
            billing_cycle: None,
            time_zone: "UTC".to_string(),
            utc_offset_seconds: 0,
        })
        .expect("refresh should be represented as an account-local result")
        .wait()
        .expect("refresh state");

    assert!(refresh.stale);
    assert_eq!(refresh.snapshot, Some(previous.clone()));
    assert!(matches!(
        refresh.error,
        Some(HistoryError::Transport(TransportError::Network))
    ));
    assert_eq!(
        store
            .load("cursor", "account-a")
            .expect("old snapshot remains"),
        Some(previous)
    );
}

#[test]
fn complete_verified_refresh_replaces_only_its_account_snapshot() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-service-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let service = HistoryService::new(
        Arc::new(ServiceCredentials),
        Arc::new(SuccessfulPageTransport),
        store.clone(),
        HistoryScheduler::isolated_for_test(),
    );

    let refresh = service
        .refresh(HistoryDemand {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            now_ms: 1_800_000_000_000,
            billing_cycle: None,
            time_zone: "UTC".to_string(),
            utc_offset_seconds: 0,
        })
        .expect("schedule refresh")
        .wait()
        .expect("refresh state");

    assert!(!refresh.stale);
    assert!(refresh.error.is_none());
    let history = refresh.snapshot.expect("complete snapshot");
    assert_eq!(history.account_id, "account-a");
    assert_eq!(history.buckets[0].input_tokens, 10);
    assert_eq!(
        service
            .cached("cursor", "account-a")
            .expect("cached history"),
        Some(history)
    );
    assert_eq!(
        service
            .cached("cursor", "account-b")
            .expect("other account"),
        None
    );
}

#[test]
fn credential_generation_change_at_commit_keeps_the_previous_snapshot() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-service-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let previous = super::store_tests::complete_history("account-a", 1_700_000_000_001);
    store
        .save("cursor", "account-a", &previous)
        .expect("seed previous snapshot");
    let service = HistoryService::new(
        Arc::new(CommitRejectedCredentials),
        Arc::new(SuccessfulPageTransport),
        store.clone(),
        HistoryScheduler::isolated_for_test(),
    );

    let refresh = service
        .refresh(HistoryDemand {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            now_ms: 1_800_000_000_000,
            billing_cycle: None,
            time_zone: "UTC".to_string(),
            utc_offset_seconds: 0,
        })
        .expect("schedule refresh")
        .wait()
        .expect("refresh state");

    assert!(refresh.stale);
    assert!(matches!(
        refresh.error,
        Some(HistoryError::CredentialLeaseChanged)
    ));
    assert_eq!(refresh.snapshot, Some(previous.clone()));
    assert_eq!(
        store.load("cursor", "account-a").expect("old snapshot"),
        Some(previous)
    );
}
