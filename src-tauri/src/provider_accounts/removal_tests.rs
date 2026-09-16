use super::registry_store_tests::{PersistedCursorAdapter, temporary_app_data_dir};
use super::{OperationStatus, ProviderAccounts, ProviderOperation};
use crate::plugin_engine::runtime::PluginOutput;

#[test]
fn removal_survives_stale_writers_and_reconnect_uses_new_identity_record() {
    let dir = temporary_app_data_dir("remove-stale");
    let first = ProviderAccounts::with_store([23; 32], &dir).unwrap();
    first.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    first.perform("cursor", ProviderOperation::RefreshActive);
    let stale = ProviderAccounts::with_store([23; 32], &dir).unwrap();
    let old_provider = stale.providers.lock().unwrap()["cursor"].clone();
    let old_id = old_provider.accounts[0].account_id.clone();
    let output = PluginOutput {
        provider_id: "cursor".into(),
        display_name: "Cursor".into(),
        plan: None,
        lines: vec![],
        icon_url: String::new(),
    };
    first
        .snapshot_store
        .as_ref()
        .unwrap()
        .save(
            "cursor",
            &old_id,
            &output,
            "2026-09-16T00:00:00Z",
            "2026-09-16T00:00:00Z",
        )
        .unwrap();
    assert_eq!(
        first
            .perform(
                "cursor",
                ProviderOperation::RemoveAccount {
                    account_id: old_id.clone()
                }
            )
            .status,
        OperationStatus::Succeeded
    );
    assert!(
        first
            .snapshot_store
            .as_ref()
            .unwrap()
            .load("cursor", &old_id)
            .unwrap()
            .is_none()
    );
    let merged = stale.persist_provider("cursor", &old_provider).unwrap();
    assert!(merged.accounts.is_empty());
    stale.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    stale.perform("cursor", ProviderOperation::RefreshActive);
    assert!(stale.view("cursor").unwrap().accounts.is_empty());
    let restored = stale.perform("cursor", ProviderOperation::ReconnectLocal);
    assert_eq!(restored.status, OperationStatus::Succeeded);
    assert_ne!(restored.view.accounts[0].account_id, old_id);
    let merged = first.persist_provider("cursor", &old_provider).unwrap();
    assert_eq!(merged.accounts.len(), 1);
    assert_eq!(
        merged.accounts[0].account_id,
        restored.view.accounts[0].account_id
    );
}

#[test]
fn removing_one_identity_does_not_suppress_a_different_login_on_the_same_source() {
    use super::{
        ConnectionKind, DiscoveryReport, ObservedConnection, ProviderAccountAdapter, SourceOutcome,
        SourceStatus,
    };
    struct Login(&'static str);
    impl ProviderAccountAdapter for Login {
        fn discover_default(&self) -> Result<DiscoveryReport, String> {
            Ok(DiscoveryReport {
                observations: vec![ObservedConnection {
                    identity_namespace: "cursor-sub-v1".into(),
                    normalized_identity: self.0.into(),
                    connection_key: "cursor-desktop".into(),
                    connection_kind: ConnectionKind::Desktop,
                }],
                source_outcomes: vec![SourceOutcome::new(
                    "cursor-desktop",
                    SourceStatus::Available,
                )],
                default_connection_key: Some("cursor-desktop".into()),
            })
        }
    }
    let accounts = ProviderAccounts::in_memory([3; 32]);
    accounts.register_adapter("cursor", Box::new(Login("auth0|a")));
    let first = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let a = first.view.accounts[0].account_id.clone();
    accounts.perform(
        "cursor",
        ProviderOperation::RemoveAccount {
            account_id: a.clone(),
        },
    );
    accounts.register_adapter("cursor", Box::new(Login("auth0|b")));
    let second = accounts.perform("cursor", ProviderOperation::RefreshActive);
    assert_eq!(second.view.accounts.len(), 1);
    assert_ne!(second.view.accounts[0].account_id, a);
    let b = second.view.accounts[0].account_id.clone();
    accounts.register_adapter("cursor", Box::new(Login("auth0|a")));
    accounts.perform("cursor", ProviderOperation::RefreshActive);
    assert_eq!(accounts.view("cursor").unwrap().accounts[0].account_id, b);
    let reconnected = accounts.perform("cursor", ProviderOperation::ReconnectLocal);
    assert_eq!(reconnected.view.accounts.len(), 2);
    assert!(
        reconnected
            .view
            .accounts
            .iter()
            .all(|account| account.account_id != a)
    );
}

#[test]
fn failed_cache_cleanup_still_reports_committed_removal_and_can_retry() {
    let dir = temporary_app_data_dir("remove-cleanup-failed");
    let accounts = ProviderAccounts::with_store([23; 32], &dir).unwrap();
    accounts.register_adapter("cursor", Box::new(PersistedCursorAdapter));
    let initial = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let id = initial.view.accounts[0].account_id.clone();
    let snapshot_path = dir.join("provider-account-snapshots.json");
    std::fs::write(&snapshot_path, "invalid snapshot").unwrap();
    let result = accounts.perform(
        "cursor",
        ProviderOperation::RemoveAccount {
            account_id: id.clone(),
        },
    );
    assert_eq!(result.status, OperationStatus::Failed);
    assert!(result.view.active_account_id.is_none());
    assert!(accounts.removal_committed("cursor", &id));
    assert!(!accounts.removal_committed("cursor", "never-present"));
    std::fs::write(&snapshot_path, r#"{"version":1,"providers":{}}"#).unwrap();
    let retried = accounts.perform(
        "cursor",
        ProviderOperation::RemoveAccount { account_id: id },
    );
    assert_eq!(retried.status, OperationStatus::Succeeded);
}
