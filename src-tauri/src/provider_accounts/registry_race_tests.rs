use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::plugin_engine::runtime::PluginOutput;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

fn temporary_app_data_dir(test_name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "openusage-provider-account-race-{test_name}-{}",
        uuid::Uuid::new_v4()
    ))
}

struct TwoAccountProbeAdapter;

impl ProviderAccountAdapter for TwoAccountProbeAdapter {
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

    fn probe_connection(
        &self,
        connection_key: &str,
        _credential_generation: &str,
    ) -> Result<PluginOutput, String> {
        Ok(PluginOutput {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            plan: Some(connection_key.to_string()),
            lines: vec![],
            icon_url: String::new(),
        })
    }
}

#[test]
fn stale_process_cannot_publish_after_another_process_selects_a_different_account() {
    let app_data_dir = temporary_app_data_dir("stale-publication-selection");
    let seeded = ProviderAccounts::with_store([42_u8; 32], &app_data_dir).unwrap();
    seeded.register_adapter("cursor", Box::new(TwoAccountProbeAdapter));
    assert_eq!(
        seeded
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    drop(seeded);

    let stale = ProviderAccounts::with_store([42_u8; 32], &app_data_dir).unwrap();
    stale.register_adapter("cursor", Box::new(TwoAccountProbeAdapter));
    assert_eq!(
        stale
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let prepared = stale.prepare_active_probe("cursor").unwrap();

    let selector = ProviderAccounts::with_store([42_u8; 32], &app_data_dir).unwrap();
    let cli_account_id = selector
        .view("cursor")
        .unwrap()
        .accounts
        .into_iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id;
    assert_eq!(
        selector
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: cli_account_id,
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    let published = Arc::new(AtomicUsize::new(0));
    let published_once = Arc::clone(&published);
    assert_eq!(
        stale
            .publish_active_probe(prepared, move |_, _| {
                published_once.fetch_add(1, Ordering::SeqCst);
            })
            .err()
            .as_deref(),
        Some("Account selection changed during refresh. Try again.")
    );
    assert_eq!(published.load(Ordering::SeqCst), 0);
    assert!(
        !app_data_dir
            .join("provider-account-snapshots.json")
            .exists()
    );
    let _ = std::fs::remove_dir_all(app_data_dir);
}

#[test]
fn a_failed_persistence_write_does_not_mutate_the_in_memory_selection() {
    let app_data_dir = temporary_app_data_dir("failed-selection-persistence");
    let accounts = ProviderAccounts::with_store([44_u8; 32], &app_data_dir).unwrap();
    accounts.register_adapter("cursor", Box::new(TwoAccountProbeAdapter));
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let before = accounts.view("cursor").unwrap();
    let cli_account_id = before
        .accounts
        .iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id
        .clone();
    std::fs::remove_dir_all(&app_data_dir).unwrap();
    std::fs::write(&app_data_dir, "blocks provider account directory").unwrap();

    let receipt = accounts.perform(
        "cursor",
        ProviderOperation::SelectActive {
            account_id: cli_account_id,
        },
    );

    assert_eq!(receipt.status, OperationStatus::Failed);
    assert_eq!(accounts.view("cursor").unwrap().selection, before.selection);
    assert_eq!(
        accounts.view("cursor").unwrap().active_account_id,
        before.active_account_id
    );
    std::fs::remove_file(app_data_dir).unwrap();
}
