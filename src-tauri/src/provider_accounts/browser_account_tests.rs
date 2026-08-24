use super::{
    AccountSelection, ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus,
    ProviderAccountAdapter, ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::browser_sessions::{
    BrokerClock, Browser, BrowserSessionBroker, CancellationToken, ClockReading, CookieProvider,
    ProcessOutput, ProcessRunError, ProviderIdentityTransport, ProviderTransportError,
    SidecarRunner, ValidationOutcome, VerifiedIdentity,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct CookieRunner;

impl SidecarRunner for CookieRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Chrome","profileKey":"Profile 2","provider":"Cursor","candidates":[{"storeId":"/Users/alice/Secret/Profile 2","host":"cursor.com","cookieHeader":"WorkosCursorSessionToken=browser-secret"}],"warnings":[]}"#.to_vec(),
        })
    }
}

struct MutableIdentityTransport(Mutex<String>);

impl MutableIdentityTransport {
    fn new(identity: &str) -> Self {
        Self(Mutex::new(identity.to_string()))
    }
}

impl ProviderIdentityTransport for MutableIdentityTransport {
    fn validate(
        &self,
        _provider: CookieProvider,
        _cookie_header: &str,
        _timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        Ok(ValidationOutcome::Verified(
            VerifiedIdentity::new(self.0.lock().unwrap().clone()).expect("identity"),
        ))
    }
}

struct FixedClock;

impl BrokerClock for FixedClock {
    fn now(&self) -> ClockReading {
        ClockReading {
            monotonic: Duration::from_secs(100),
            unix_ms: 1_800_000_000_000,
        }
    }
}

fn broker(identity: &str) -> Arc<BrowserSessionBroker> {
    Arc::new(BrowserSessionBroker::with_dependencies(
        Arc::new(CookieRunner),
        Arc::new(MutableIdentityTransport::new(identity)),
        Arc::new(FixedClock),
    ))
}

struct SharedLocalAdapter;

impl ProviderAccountAdapter for SharedLocalAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "cursor-sub-v1".to_string(),
                normalized_identity: "auth0|shared-subject".to_string(),
                connection_key: "cursor-desktop".to_string(),
                connection_kind: ConnectionKind::Desktop,
            }],
            source_outcomes: vec![SourceOutcome::new(
                "cursor-desktop",
                SourceStatus::Available,
            )],
            default_connection_key: Some("cursor-desktop".to_string()),
        })
    }
}

fn candidate_id(broker: &BrowserSessionBroker) -> String {
    broker
        .discover_specific(
            Browser::Chrome,
            "Profile 2",
            CookieProvider::Cursor,
            &CancellationToken::new(),
        )
        .candidate
        .expect("verified candidate")
        .candidate_id
}

#[test]
fn attaching_a_new_cursor_browser_account_pins_it_without_serializing_secrets() {
    let directory = std::env::temp_dir().join(format!(
        "openusage-browser-account-{}",
        uuid::Uuid::new_v4()
    ));
    let accounts = ProviderAccounts::with_store([41_u8; 32], &directory).unwrap();
    let broker = broker("auth0|browser-subject");
    accounts.set_browser_broker(Arc::clone(&broker));

    let receipt = accounts.perform(
        "cursor",
        ProviderOperation::AttachBrowserCandidate {
            candidate_id: candidate_id(&broker),
        },
    );

    assert_eq!(receipt.status, OperationStatus::Succeeded);
    assert_eq!(receipt.view.accounts.len(), 1);
    let account = &receipt.view.accounts[0];
    assert_eq!(
        receipt.view.selection,
        AccountSelection::Pinned(account.account_id.clone())
    );
    assert_eq!(account.connection_kinds, vec![ConnectionKind::Chrome]);
    assert_eq!(
        account.connections[0].profile_key.as_deref(),
        Some("Profile 2")
    );
    let view_json = serde_json::to_string(&receipt.view).unwrap();
    let registry_json = std::fs::read_to_string(directory.join("provider-accounts.json"))
        .expect("registry persisted");
    for secret in [
        "browser-secret",
        "browser-subject",
        "/Users/alice",
        "storeId",
        "sessionRef",
        "session_ref",
    ] {
        assert!(!view_json.contains(secret));
        assert!(!registry_json.contains(secret));
    }
}

#[test]
fn attaching_a_browser_connection_to_an_existing_identity_preserves_selection() {
    let accounts = ProviderAccounts::in_memory([43_u8; 32]);
    accounts.register_adapter("cursor", Box::new(SharedLocalAdapter));
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let broker = broker("auth0|shared-subject");
    accounts.set_browser_broker(Arc::clone(&broker));
    let before = accounts.view("cursor").unwrap();

    let receipt = accounts.perform(
        "cursor",
        ProviderOperation::AttachBrowserCandidate {
            candidate_id: candidate_id(&broker),
        },
    );

    assert_eq!(receipt.status, OperationStatus::Succeeded);
    assert_eq!(receipt.view.selection, before.selection);
    assert_eq!(receipt.view.active_account_id, before.active_account_id);
    assert_eq!(receipt.view.accounts.len(), 1);
    assert_eq!(
        receipt.view.accounts[0].connection_kinds,
        vec![ConnectionKind::Desktop, ConnectionKind::Chrome]
    );
}

#[test]
fn failed_cursor_attachment_releases_the_claimed_browser_session() {
    let directory = std::env::temp_dir().join(format!(
        "openusage-browser-account-failure-{}",
        uuid::Uuid::new_v4()
    ));
    let accounts = ProviderAccounts::with_store([45_u8; 32], &directory).unwrap();
    let broker = broker("auth0|browser-subject");
    accounts.set_browser_broker(Arc::clone(&broker));
    let candidate_id = candidate_id(&broker);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::remove_dir_all(&directory).unwrap();
    std::fs::write(&directory, "blocks provider account directory").unwrap();

    let receipt = accounts.perform(
        "cursor",
        ProviderOperation::AttachBrowserCandidate { candidate_id },
    );

    assert_eq!(receipt.status, OperationStatus::Failed);
    assert_eq!(broker.retained_session_count(), 0);
    std::fs::remove_file(directory).unwrap();
}

#[test]
fn detaching_a_browser_connection_keeps_the_pinned_account_as_stale_history() {
    let accounts = ProviderAccounts::in_memory([47_u8; 32]);
    let broker = broker("auth0|browser-only");
    accounts.set_browser_broker(Arc::clone(&broker));
    let attached = accounts.perform(
        "cursor",
        ProviderOperation::AttachBrowserCandidate {
            candidate_id: candidate_id(&broker),
        },
    );
    let account_id = attached.view.accounts[0].account_id.clone();
    let connection_id = attached.view.accounts[0].connections[0]
        .connection_id
        .clone();

    let detached = accounts.perform(
        "cursor",
        ProviderOperation::DetachConnection {
            account_id: account_id.clone(),
            connection_id,
        },
    );

    assert_eq!(detached.status, OperationStatus::Succeeded);
    assert_eq!(
        detached.view.selection,
        AccountSelection::Pinned(account_id.clone())
    );
    assert_eq!(detached.view.active_account_id, Some(account_id));
    assert_eq!(detached.view.accounts.len(), 1);
    assert!(detached.view.accounts[0].stale);
    assert!(detached.view.accounts[0].connections.is_empty());
}

#[test]
fn a_stale_process_cannot_reattach_an_explicitly_detached_browser_profile() {
    let directory = std::env::temp_dir().join(format!(
        "openusage-browser-detach-race-{}",
        uuid::Uuid::new_v4()
    ));
    let seeded = ProviderAccounts::with_store([49_u8; 32], &directory).unwrap();
    let seeded_broker = broker("auth0|browser-only");
    seeded.set_browser_broker(Arc::clone(&seeded_broker));
    let attached = seeded.perform(
        "cursor",
        ProviderOperation::AttachBrowserCandidate {
            candidate_id: candidate_id(&seeded_broker),
        },
    );
    let account_id = attached.view.accounts[0].account_id.clone();
    let connection_id = attached.view.accounts[0].connections[0]
        .connection_id
        .clone();
    drop(seeded);

    let stale = ProviderAccounts::with_store([49_u8; 32], &directory).unwrap();
    let detacher = ProviderAccounts::with_store([49_u8; 32], &directory).unwrap();
    assert_eq!(
        detacher
            .perform(
                "cursor",
                ProviderOperation::DetachConnection {
                    account_id: account_id.clone(),
                    connection_id,
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    assert_eq!(
        stale
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: account_id.clone(),
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    let reopened = ProviderAccounts::with_store([49_u8; 32], &directory).unwrap();
    let account = reopened
        .view("cursor")
        .unwrap()
        .accounts
        .into_iter()
        .find(|account| account.account_id == account_id)
        .unwrap();
    assert!(account.connections.is_empty());
    let _ = std::fs::remove_dir_all(directory);
}
