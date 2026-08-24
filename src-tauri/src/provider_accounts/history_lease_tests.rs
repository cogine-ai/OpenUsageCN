use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::browser_sessions::{
    BrokerClock, Browser, BrowserSessionBroker, CancellationToken, ClockReading, CookieProvider,
    ProcessOutput, ProcessRunError, ProviderIdentityTransport, ProviderTransportError,
    SidecarRunner, ValidationOutcome, VerifiedIdentity,
};
use crate::cursor_history::{CredentialLeasePort, CredentialRequest, HistoryError};
use crate::plugin_engine::account_runtime::HistoryCredential;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn temporary_app_data_dir(test_name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "openusage-history-lease-{test_name}-{}",
        uuid::Uuid::new_v4()
    ))
}

struct HistoryAdapter {
    generation: Arc<Mutex<String>>,
}

impl ProviderAccountAdapter for HistoryAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![
                ObservedConnection {
                    identity_namespace: "cursor-sub-v1".to_string(),
                    normalized_identity: "auth0|desktop-user".to_string(),
                    connection_key: "cursor-desktop".to_string(),
                    connection_kind: ConnectionKind::Desktop,
                },
                ObservedConnection {
                    identity_namespace: "cursor-sub-v1".to_string(),
                    normalized_identity: "auth0|cli-user".to_string(),
                    connection_key: "cursor-cli".to_string(),
                    connection_kind: ConnectionKind::Cli,
                },
            ],
            source_outcomes: vec![
                SourceOutcome::new("cursor-desktop", SourceStatus::Available),
                SourceOutcome::new("cursor-cli", SourceStatus::Available),
            ],
            default_connection_key: Some("cursor-desktop".to_string()),
        })
    }

    fn credential_generation(&self, _connection_key: &str) -> Result<String, String> {
        Ok(self.generation.lock().unwrap().clone())
    }

    fn history_cookie(
        &self,
        connection_key: &str,
        _credential_generation: &str,
    ) -> Result<HistoryCredential, String> {
        Ok(HistoryCredential::new(format!(
            "WorkosCursorSessionToken={connection_key}-secret"
        )))
    }
}

fn register(accounts: &ProviderAccounts, generation: &Arc<Mutex<String>>) {
    accounts.register_adapter(
        "cursor",
        Box::new(HistoryAdapter {
            generation: Arc::clone(generation),
        }),
    );
}

fn discover(accounts: &ProviderAccounts) {
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
}

#[test]
fn history_lease_is_account_scoped_and_matches_only_the_full_subject() {
    let generation = Arc::new(Mutex::new("a".repeat(64)));
    let accounts = ProviderAccounts::in_memory([41_u8; 32]);
    register(&accounts, &generation);
    discover(&accounts);
    let view = accounts.view("cursor").unwrap();
    let account_id = view.active_account_id.unwrap();

    let lease = accounts
        .acquire(CredentialRequest {
            provider_id: "cursor",
            account_id: &account_id,
        })
        .expect("lease succeeds");

    assert_eq!(lease.account_id(), account_id);
    assert_eq!(lease.generation(), "a".repeat(64));
    assert_eq!(lease.candidates().len(), 1);
    assert!(
        accounts
            .identity_matches(&lease, "auth0|desktop-user")
            .unwrap()
    );
    assert!(!accounts.identity_matches(&lease, "desktop-user").unwrap());
}

#[test]
fn credential_change_rejects_history_commit_without_running_it() {
    let generation = Arc::new(Mutex::new("a".repeat(64)));
    let accounts = ProviderAccounts::in_memory([43_u8; 32]);
    register(&accounts, &generation);
    discover(&accounts);
    let account_id = accounts.view("cursor").unwrap().active_account_id.unwrap();
    let lease = accounts
        .acquire(CredentialRequest {
            provider_id: "cursor",
            account_id: &account_id,
        })
        .unwrap();
    *generation.lock().unwrap() = "b".repeat(64);
    let mut committed = false;
    let mut commit = || {
        committed = true;
        Ok(())
    };

    assert_eq!(
        accounts.with_current_lease(&lease, &mut commit),
        Err(HistoryError::CredentialLeaseChanged)
    );
    assert!(!committed);
}

#[test]
fn another_process_selection_change_rejects_history_commit() {
    let directory = temporary_app_data_dir("cross-process");
    let generation = Arc::new(Mutex::new("c".repeat(64)));
    let first = ProviderAccounts::with_store([47_u8; 32], &directory).unwrap();
    register(&first, &generation);
    discover(&first);
    let view = first.view("cursor").unwrap();
    let desktop = view
        .accounts
        .iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Desktop])
        .unwrap()
        .account_id
        .clone();
    let cli = view
        .accounts
        .iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id
        .clone();
    let lease = first
        .acquire(CredentialRequest {
            provider_id: "cursor",
            account_id: &desktop,
        })
        .unwrap();

    let second = ProviderAccounts::with_store([47_u8; 32], &directory).unwrap();
    register(&second, &generation);
    assert_eq!(
        second
            .perform(
                "cursor",
                ProviderOperation::SelectActive { account_id: cli },
            )
            .status,
        OperationStatus::Succeeded
    );
    let mut committed = false;
    let mut commit = || {
        committed = true;
        Ok(())
    };

    assert_eq!(
        first.with_current_lease(&lease, &mut commit),
        Err(HistoryError::CredentialLeaseChanged)
    );
    assert!(!committed);
}

struct BrowserHistoryRunner(AtomicUsize);

impl SidecarRunner for BrowserHistoryRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Default","provider":"Cursor","candidates":[{"storeId":"/Users/alice/Secret/Default","host":"cursor.com","cookieHeader":"WorkosCursorSessionToken=history-browser-secret"}],"warnings":[]}"#.to_vec(),
        })
    }
}

struct BrowserHistoryIdentity;

impl ProviderIdentityTransport for BrowserHistoryIdentity {
    fn validate(
        &self,
        _provider: CookieProvider,
        _cookie_header: &str,
        _timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        Ok(ValidationOutcome::Verified(
            VerifiedIdentity::new("auth0|history-browser".to_string()).unwrap(),
        ))
    }
}

struct BrowserHistoryClock;

impl BrokerClock for BrowserHistoryClock {
    fn now(&self) -> ClockReading {
        ClockReading {
            monotonic: Duration::from_secs(100),
            unix_ms: 1_800_000_000_000,
        }
    }
}

fn history_browser_broker(runner: Arc<BrowserHistoryRunner>) -> Arc<BrowserSessionBroker> {
    Arc::new(BrowserSessionBroker::with_dependencies(
        runner,
        Arc::new(BrowserHistoryIdentity),
        Arc::new(BrowserHistoryClock),
    ))
}

fn attach_browser_account(
    accounts: &ProviderAccounts,
    broker: &Arc<BrowserSessionBroker>,
) -> String {
    accounts.set_browser_broker(Arc::clone(broker));
    let candidate_id = broker
        .discover_specific(
            Browser::Arc,
            "Default",
            CookieProvider::Cursor,
            &CancellationToken::new(),
        )
        .candidate
        .unwrap()
        .candidate_id;
    let receipt = accounts.perform(
        "cursor",
        ProviderOperation::AttachBrowserCandidate { candidate_id },
    );
    assert_eq!(receipt.status, OperationStatus::Succeeded);
    receipt.view.active_account_id.unwrap()
}

#[test]
fn browser_history_reacquires_the_persisted_exact_profile_after_restart() {
    let directory = temporary_app_data_dir("browser-restart");
    let runner = Arc::new(BrowserHistoryRunner(AtomicUsize::new(0)));
    let broker = history_browser_broker(Arc::clone(&runner));
    let first = ProviderAccounts::with_store([53_u8; 32], &directory).unwrap();
    let account_id = attach_browser_account(&first, &broker);
    drop(first);

    let restarted = ProviderAccounts::with_store([53_u8; 32], &directory).unwrap();
    restarted.set_browser_broker(Arc::clone(&broker));
    let lease = restarted
        .acquire(CredentialRequest {
            provider_id: "cursor",
            account_id: &account_id,
        })
        .expect("persisted exact profile reacquires");

    assert_eq!(lease.candidates().len(), 1);
    assert!(
        restarted
            .identity_matches(&lease, "auth0|history-browser")
            .unwrap()
    );
    assert!(restarted.is_current(&lease));
    assert_eq!(runner.0.load(Ordering::SeqCst), 2);
}

#[test]
fn detached_browser_history_is_not_reacquired_after_restart() {
    let directory = temporary_app_data_dir("browser-detached");
    let runner = Arc::new(BrowserHistoryRunner(AtomicUsize::new(0)));
    let broker = history_browser_broker(Arc::clone(&runner));
    let first = ProviderAccounts::with_store([59_u8; 32], &directory).unwrap();
    let account_id = attach_browser_account(&first, &broker);
    let connection_id = first.view("cursor").unwrap().accounts[0].connections[0]
        .connection_id
        .clone();
    assert_eq!(
        first
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
    drop(first);

    let restarted = ProviderAccounts::with_store([59_u8; 32], &directory).unwrap();
    restarted.set_browser_broker(Arc::clone(&broker));
    assert!(matches!(
        restarted.acquire(CredentialRequest {
            provider_id: "cursor",
            account_id: &account_id,
        }),
        Err(HistoryError::AuthenticationUnavailable)
    ));
    assert_eq!(runner.0.load(Ordering::SeqCst), 1);
}
