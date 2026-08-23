use std::sync::Mutex;

use super::*;

struct TestCredentials;

impl CredentialLeasePort for TestCredentials {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError> {
        Ok(CredentialLease::new(
            request.provider_id.to_string(),
            request.account_id.to_string(),
            "generation-7".to_string(),
            vec![
                CredentialCandidate::new(
                    "first".to_string(),
                    SecretCookie::new("first-secret".to_string()),
                ),
                CredentialCandidate::new(
                    "second".to_string(),
                    SecretCookie::new("second-secret".to_string()),
                ),
            ],
        ))
    }

    fn identity_matches(
        &self,
        _lease: &CredentialLease,
        subject: &str,
    ) -> Result<bool, HistoryError> {
        Ok(subject == "second-subject")
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

#[derive(Default)]
struct TestTransport {
    auth_candidates: Mutex<Vec<String>>,
    page_candidates: Mutex<Vec<String>>,
}

impl HistoryTransport for TestTransport {
    fn authenticate(
        &self,
        candidate: &CredentialCandidate,
        _correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        self.auth_candidates
            .lock()
            .unwrap()
            .push(candidate.candidate_id().to_string());
        if candidate.candidate_id() == "first" {
            Ok(AuthOutcome::CandidateRejected)
        } else {
            Ok(AuthOutcome::Authenticated(AuthIdentity::new(
                "second-subject".to_string(),
            )))
        }
    }

    fn fetch_page(
        &self,
        candidate: &CredentialCandidate,
        request: &PageRequest,
        _correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        self.page_candidates
            .lock()
            .unwrap()
            .push(candidate.candidate_id().to_string());
        Ok(ScriptedPage {
            page: request.page,
            events: vec![],
            total_usage_events_count: Some(0),
        })
    }
}

#[test]
fn candidate_rejection_falls_through_and_pages_reuse_the_verified_candidate() {
    let transport = TestTransport::default();
    let history = fetch_complete_history(
        &TestCredentials,
        &transport,
        FetchRequest {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            from_ms: 1_700_000_000_000,
            to_ms: 1_700_086_400_000,
            fetched_at_ms: 1_700_086_400_001,
            time_zone: "Asia/Taipei".to_string(),
            utc_offset_seconds: 8 * 60 * 60,
        },
    )
    .expect("the second candidate should produce complete history");

    assert_eq!(history.account_id, "account-a");
    assert_eq!(
        transport.auth_candidates.into_inner().unwrap(),
        vec!["first", "second"]
    );
    assert_eq!(
        transport.page_candidates.into_inner().unwrap(),
        vec!["second"]
    );
}

struct IdentityCredentials;

impl CredentialLeasePort for IdentityCredentials {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError> {
        Ok(CredentialLease::new(
            request.provider_id.to_string(),
            request.account_id.to_string(),
            "generation-8".to_string(),
            vec![
                CredentialCandidate::new(
                    "wrong".to_string(),
                    SecretCookie::new("wrong-secret".to_string()),
                ),
                CredentialCandidate::new(
                    "right".to_string(),
                    SecretCookie::new("right-secret".to_string()),
                ),
            ],
        ))
    }

    fn identity_matches(
        &self,
        _lease: &CredentialLease,
        subject: &str,
    ) -> Result<bool, HistoryError> {
        Ok(subject == "right-subject")
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

#[derive(Default)]
struct IdentityTransport {
    auth_candidates: Mutex<Vec<String>>,
}

impl HistoryTransport for IdentityTransport {
    fn authenticate(
        &self,
        candidate: &CredentialCandidate,
        _correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        self.auth_candidates
            .lock()
            .unwrap()
            .push(candidate.candidate_id().to_string());
        Ok(AuthOutcome::Authenticated(AuthIdentity::new(format!(
            "{}-subject",
            candidate.candidate_id()
        ))))
    }

    fn fetch_page(
        &self,
        _candidate: &CredentialCandidate,
        _request: &PageRequest,
        _correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        panic!("identity mismatch must stop before pagination")
    }
}

#[test]
fn valid_but_wrong_identity_stops_without_trying_another_candidate() {
    let transport = IdentityTransport::default();
    let result = fetch_complete_history(
        &IdentityCredentials,
        &transport,
        FetchRequest {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            from_ms: 1_700_000_000_000,
            to_ms: 1_700_086_400_000,
            fetched_at_ms: 1_700_086_400_001,
            time_zone: "UTC".to_string(),
            utc_offset_seconds: 0,
        },
    );

    assert_eq!(result, Err(HistoryError::IdentityChanged));
    assert_eq!(
        transport.auth_candidates.into_inner().unwrap(),
        vec!["wrong"]
    );
}

#[derive(Default)]
struct FatalAuthTransport {
    auth_candidates: Mutex<Vec<String>>,
}

impl HistoryTransport for FatalAuthTransport {
    fn authenticate(
        &self,
        candidate: &CredentialCandidate,
        _correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        self.auth_candidates
            .lock()
            .unwrap()
            .push(candidate.candidate_id().to_string());
        Err(TransportError::Network)
    }

    fn fetch_page(
        &self,
        _candidate: &CredentialCandidate,
        _request: &PageRequest,
        _correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        panic!("fatal auth error must stop before pagination")
    }
}

#[test]
fn network_auth_failure_does_not_fall_through_to_another_identity() {
    let transport = FatalAuthTransport::default();
    let result = fetch_complete_history(
        &TestCredentials,
        &transport,
        FetchRequest {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            from_ms: 1_700_000_000_000,
            to_ms: 1_700_086_400_000,
            fetched_at_ms: 1_700_086_400_001,
            time_zone: "UTC".to_string(),
            utc_offset_seconds: 0,
        },
    );

    assert_eq!(
        result,
        Err(HistoryError::Transport(TransportError::Network))
    );
    assert_eq!(
        transport.auth_candidates.into_inner().unwrap(),
        vec!["first"]
    );
}

struct NeverCalledTransport;

impl HistoryTransport for NeverCalledTransport {
    fn authenticate(
        &self,
        _candidate: &CredentialCandidate,
        _correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        panic!("cancelled fetch must not authenticate")
    }

    fn fetch_page(
        &self,
        _candidate: &CredentialCandidate,
        _request: &PageRequest,
        _correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        panic!("cancelled fetch must not paginate")
    }
}

#[test]
fn cancellation_stops_before_authentication_or_pagination() {
    let credentials = TestCredentials;
    let lease = credentials
        .acquire(CredentialRequest {
            provider_id: "cursor",
            account_id: "account-a",
        })
        .expect("test lease");
    let result = fetch_complete_history_with_lease(
        &credentials,
        &NeverCalledTransport,
        &lease,
        FetchRequest {
            provider_id: "cursor".to_string(),
            account_id: "account-a".to_string(),
            from_ms: 1_700_000_000_000,
            to_ms: 1_700_086_400_000,
            fetched_at_ms: 1_700_086_400_001,
            time_zone: "UTC".to_string(),
            utc_offset_seconds: 0,
        },
        &|| true,
    );

    assert_eq!(result, Err(HistoryError::Cancelled));
}
