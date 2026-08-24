use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::keychain::{InstallationKey, InstallationKeyError, InstallationKeyStore};
use crate::plugin_engine::runtime::{MetricLine, PluginOutput};

struct PersistedCursorAdapter;

impl ProviderAccountAdapter for PersistedCursorAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "cursor-sub-v1".to_string(),
                normalized_identity: "auth0|persisted-user".to_string(),
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

fn temporary_app_data_dir(test_name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "openusage-provider-accounts-{test_name}-{}",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn account_and_connection_ids_survive_a_restart() {
    let app_data_dir = temporary_app_data_dir("restart");
    let first = ProviderAccounts::with_store([23_u8; 32], &app_data_dir).expect("store opens");
    first.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    assert_eq!(
        first
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let before = first.view("cursor").expect("first view");
    let account_id = before.accounts[0].account_id.clone();
    let first_stored = std::fs::read_to_string(app_data_dir.join("provider-accounts.json"))
        .expect("registry is persisted");
    let first_json: serde_json::Value = serde_json::from_str(&first_stored).unwrap();
    assert!(
        first_json["providers"]["cursor"]["accounts"].is_object(),
        "schema v1 keys accounts by AccountId"
    );
    let connection_id = first_json["providers"]["cursor"]["accounts"][&account_id]["connections"]
        [0]["connectionId"]
        .as_str()
        .expect("connection ID is persisted")
        .to_string();
    drop(first);

    let restarted =
        ProviderAccounts::with_store([23_u8; 32], &app_data_dir).expect("store reopens");
    let after = restarted.view("cursor").expect("restarted view");

    assert_eq!(after.selection, before.selection);
    assert_eq!(after.active_account_id, before.active_account_id);
    assert_eq!(after.accounts[0].account_id, before.accounts[0].account_id);
    assert!(
        after.accounts[0].stale,
        "runtime availability is rediscovered after restart"
    );
    restarted.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    assert_eq!(
        restarted
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let stored = std::fs::read_to_string(app_data_dir.join("provider-accounts.json"))
        .expect("registry is persisted");
    let stored_json: serde_json::Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(
        stored_json["providers"]["cursor"]["accounts"][&account_id]["connections"][0]["connectionId"],
        connection_id
    );
    assert!(!stored.contains("auth0|persisted-user"));
    assert!(stored.contains("cursor-sub-v1"));
    let _ = std::fs::remove_dir_all(app_data_dir);
}

struct IdentityAdapter {
    identity: &'static str,
    connection_key: &'static str,
}

impl ProviderAccountAdapter for IdentityAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "cursor-sub-v1".to_string(),
                normalized_identity: self.identity.to_string(),
                connection_key: self.connection_key.to_string(),
                connection_kind: ConnectionKind::Desktop,
            }],
            source_outcomes: vec![SourceOutcome::new(
                self.connection_key,
                SourceStatus::Available,
            )],
            default_connection_key: Some(self.connection_key.to_string()),
        })
    }
}

#[test]
fn stale_process_writers_merge_accounts_for_the_same_provider() {
    let app_data_dir = temporary_app_data_dir("merge");
    let first = ProviderAccounts::with_store([25_u8; 32], &app_data_dir).unwrap();
    let second = ProviderAccounts::with_store([25_u8; 32], &app_data_dir).unwrap();
    first.register_adapter(
        "cursor",
        Box::new(IdentityAdapter {
            identity: "auth0|first-user",
            connection_key: "desktop-first",
        }),
    );
    second.register_adapter(
        "cursor",
        Box::new(IdentityAdapter {
            identity: "auth0|second-user",
            connection_key: "desktop-second",
        }),
    );

    assert_eq!(
        first
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        second
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(second.view("cursor").unwrap().accounts.len(), 2);

    let restarted = ProviderAccounts::with_store([25_u8; 32], &app_data_dir).unwrap();
    assert_eq!(restarted.view("cursor").unwrap().accounts.len(), 2);
    let _ = std::fs::remove_dir_all(app_data_dir);
}

#[test]
fn damaged_registry_is_reported_and_never_rewritten() {
    let app_data_dir = temporary_app_data_dir("corrupt");
    std::fs::create_dir_all(&app_data_dir).unwrap();
    let path = app_data_dir.join("provider-accounts.json");
    let damaged = b"{not valid provider account json";
    std::fs::write(&path, damaged).unwrap();

    let error = ProviderAccounts::with_store([27_u8; 32], &app_data_dir)
        .err()
        .expect("damaged registry must fail visibly");

    assert_eq!(error, "provider account storage is damaged");
    assert_eq!(std::fs::read(&path).unwrap(), damaged);
    let _ = std::fs::remove_dir_all(app_data_dir);
}

struct MissingKeyStore {
    create_calls: Arc<AtomicUsize>,
}

impl InstallationKeyStore for MissingKeyStore {
    fn read(&self) -> Result<InstallationKey, InstallationKeyError> {
        Err(InstallationKeyError::Missing)
    }

    fn create(&self) -> Result<InstallationKey, InstallationKeyError> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        Ok(InstallationKey::from_bytes([29_u8; 32]))
    }
}

#[test]
fn existing_registry_with_a_missing_key_never_creates_a_replacement() {
    let app_data_dir = temporary_app_data_dir("missing-key");
    let seeded = ProviderAccounts::with_store([29_u8; 32], &app_data_dir).unwrap();
    seeded.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    assert_eq!(
        seeded
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let seeded_view = seeded.view("cursor").unwrap();
    drop(seeded);

    let create_calls = Arc::new(AtomicUsize::new(0));
    let reopened = ProviderAccounts::open_with_key_store(
        &app_data_dir,
        Arc::new(MissingKeyStore {
            create_calls: Arc::clone(&create_calls),
        }),
    )
    .expect("the last account view remains readable");
    let reopened_view = reopened.view("cursor").unwrap();
    assert_eq!(reopened_view.selection, seeded_view.selection);
    assert_eq!(
        reopened_view.active_account_id,
        seeded_view.active_account_id
    );
    assert_eq!(
        reopened_view.accounts[0].account_id,
        seeded_view.accounts[0].account_id
    );
    assert!(reopened_view.accounts[0].stale);
    reopened.register_adapter("cursor", Box::new(PersistedCursorAdapter));

    let receipt = reopened.perform("cursor", ProviderOperation::RefreshActive);

    assert_eq!(receipt.status, OperationStatus::Failed);
    assert_eq!(create_calls.load(Ordering::SeqCst), 0);
    assert!(reopened_view.persistence_warning.is_none());
    let warning = receipt
        .view
        .persistence_warning
        .as_ref()
        .expect("runtime keychain failure is visible");
    assert_eq!(warning.code, "persistenceUnavailable");
    assert!(!warning.correlation_id.is_empty());
    assert_eq!(
        reopened
            .view("cursor")
            .unwrap()
            .persistence_warning
            .as_ref()
            .map(|warning| warning.correlation_id.as_str()),
        Some(warning.correlation_id.as_str())
    );
    assert_eq!(
        receipt.view.active_account_id,
        seeded_view.active_account_id
    );
    assert_eq!(receipt.view.accounts.len(), seeded_view.accounts.len());
    let _ = std::fs::remove_dir_all(app_data_dir);
}

#[test]
fn a_new_installation_creates_its_key_only_after_a_verified_observation() {
    let app_data_dir = temporary_app_data_dir("lazy-key");
    let create_calls = Arc::new(AtomicUsize::new(0));
    let accounts = ProviderAccounts::open_with_key_store(
        &app_data_dir,
        Arc::new(MissingKeyStore {
            create_calls: Arc::clone(&create_calls),
        }),
    )
    .unwrap();

    assert_eq!(create_calls.load(Ordering::SeqCst), 0);
    accounts.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(create_calls.load(Ordering::SeqCst), 1);
    assert!(app_data_dir.join("provider-accounts.json").exists());
    let _ = std::fs::remove_dir_all(app_data_dir);
}

struct SnapshotCursorAdapter;

impl ProviderAccountAdapter for SnapshotCursorAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        PersistedCursorAdapter.discover_default()
    }

    fn probe_connection(
        &self,
        _connection_key: &str,
        _credential_generation: &str,
    ) -> Result<PluginOutput, String> {
        Ok(PluginOutput {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            plan: Some("Pro+".to_string()),
            lines: vec![MetricLine::Text {
                label: "Requests".to_string(),
                value: "42".to_string(),
                color: None,
                subtitle: None,
            }],
            icon_url: "data:image/svg+xml;base64,not-for-storage".to_string(),
        })
    }
}

#[test]
fn active_probe_publication_seeds_only_its_account_snapshot_and_projection() {
    let app_data_dir = temporary_app_data_dir("snapshot-publication");
    let accounts = ProviderAccounts::with_store([39_u8; 32], &app_data_dir).unwrap();
    accounts.register_adapter("cursor", Box::new(SnapshotCursorAdapter));
    let refreshed = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let account_id = refreshed.view.active_account_id.unwrap();
    let probe = accounts
        .prepare_active_probe("cursor")
        .expect("probe is prepared");
    let projected = Arc::new(AtomicUsize::new(0));
    let projected_once = Arc::clone(&projected);

    let output = accounts
        .publish_active_probe(probe, move |_output, _started_at| {
            projected_once.fetch_add(1, Ordering::SeqCst);
        })
        .expect("probe is published");

    assert_eq!(output.plan.as_deref(), Some("Pro+"));
    assert_eq!(projected.load(Ordering::SeqCst), 1);
    let raw = std::fs::read_to_string(app_data_dir.join("provider-account-snapshots.json"))
        .expect("account snapshot exists");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["providers"]["cursor"][&account_id]["plan"], "Pro+");
    assert!(!raw.contains("not-for-storage"));
}

#[test]
fn stale_discovery_cannot_overwrite_a_newer_account_label() {
    let app_data_dir = temporary_app_data_dir("stale-label");
    let seeded = ProviderAccounts::with_store([41_u8; 32], &app_data_dir).unwrap();
    seeded.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    let seeded_receipt = seeded.perform("cursor", ProviderOperation::RefreshActive);
    let account_id = seeded_receipt.view.accounts[0].account_id.clone();
    drop(seeded);

    let renamer = ProviderAccounts::with_store([41_u8; 32], &app_data_dir).unwrap();
    let stale = ProviderAccounts::with_store([41_u8; 32], &app_data_dir).unwrap();
    assert_eq!(
        renamer
            .perform(
                "cursor",
                ProviderOperation::RenameAccount {
                    account_id: account_id.clone(),
                    label: "Work Cursor".to_string(),
                },
            )
            .status,
        OperationStatus::Succeeded
    );
    stale.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    assert_eq!(
        stale
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );

    let reopened = ProviderAccounts::with_store([41_u8; 32], &app_data_dir).unwrap();
    let account = reopened
        .view("cursor")
        .unwrap()
        .accounts
        .into_iter()
        .find(|account| account.account_id == account_id)
        .unwrap();
    assert_eq!(account.label, "Work Cursor");
}

struct TwoAccountCursorAdapter;

impl ProviderAccountAdapter for TwoAccountCursorAdapter {
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
}

#[test]
fn stale_discovery_cannot_overwrite_a_newer_pinned_selection() {
    let app_data_dir = temporary_app_data_dir("stale-selection");
    let seeded = ProviderAccounts::with_store([43_u8; 32], &app_data_dir).unwrap();
    seeded.register_adapter("cursor", Box::new(TwoAccountCursorAdapter));
    assert_eq!(
        seeded
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let cli_account_id = seeded
        .view("cursor")
        .unwrap()
        .accounts
        .into_iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id;
    drop(seeded);

    let selector = ProviderAccounts::with_store([43_u8; 32], &app_data_dir).unwrap();
    let stale = ProviderAccounts::with_store([43_u8; 32], &app_data_dir).unwrap();
    assert_eq!(
        selector
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: cli_account_id.clone(),
                },
            )
            .status,
        OperationStatus::Succeeded
    );
    stale.register_adapter("cursor", Box::new(TwoAccountCursorAdapter));
    assert_eq!(
        stale
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );

    let reopened = ProviderAccounts::with_store([43_u8; 32], &app_data_dir).unwrap();
    let view = reopened.view("cursor").unwrap();
    assert_eq!(
        view.selection,
        super::AccountSelection::Pinned(cli_account_id.clone())
    );
    assert_eq!(view.active_account_id, Some(cli_account_id));
}
