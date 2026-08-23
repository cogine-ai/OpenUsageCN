use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::plugin_engine::runtime::PluginOutput;

struct TwoAccountProjectionAdapter;

impl ProviderAccountAdapter for TwoAccountProjectionAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![
                ObservedConnection {
                    identity_namespace: "cursor-sub-v1".to_string(),
                    normalized_identity: "auth0|desktop".to_string(),
                    connection_key: "cursor-desktop".to_string(),
                    connection_kind: ConnectionKind::Desktop,
                },
                ObservedConnection {
                    identity_namespace: "cursor-sub-v1".to_string(),
                    normalized_identity: "auth0|cli".to_string(),
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
            icon_url: "data:image/svg+xml,icon".to_string(),
        })
    }

    fn output_metadata(&self) -> (String, String) {
        ("Cursor".to_string(), "data:image/svg+xml,icon".to_string())
    }
}

#[test]
fn active_projection_follows_only_the_selected_accounts_snapshot() {
    let directory = std::env::temp_dir().join(format!(
        "openusage-account-projection-{}",
        uuid::Uuid::new_v4()
    ));
    let accounts = ProviderAccounts::with_store([61_u8; 32], &directory).unwrap();
    accounts.register_adapter("cursor", Box::new(TwoAccountProjectionAdapter));
    let refreshed = accounts.perform("cursor", ProviderOperation::RefreshActive);
    assert_eq!(refreshed.status, OperationStatus::Succeeded);
    let desktop_id = refreshed.view.active_account_id.unwrap();
    let cli_id = refreshed
        .view
        .accounts
        .iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id
        .clone();

    assert!(accounts.active_projection("cursor").unwrap().is_none());
    let desktop_probe = accounts.prepare_active_probe("cursor").unwrap();
    accounts
        .publish_active_probe(desktop_probe, |_, _| {})
        .unwrap();
    assert_eq!(
        accounts
            .active_projection("cursor")
            .unwrap()
            .unwrap()
            .output
            .plan
            .as_deref(),
        Some("cursor-desktop")
    );

    accounts.perform(
        "cursor",
        ProviderOperation::SelectActive {
            account_id: cli_id.clone(),
        },
    );
    assert!(accounts.active_projection("cursor").unwrap().is_none());
    let cli_probe = accounts.prepare_active_probe("cursor").unwrap();
    accounts.publish_active_probe(cli_probe, |_, _| {}).unwrap();
    assert_eq!(
        accounts
            .active_projection("cursor")
            .unwrap()
            .unwrap()
            .output
            .plan
            .as_deref(),
        Some("cursor-cli")
    );

    accounts.perform(
        "cursor",
        ProviderOperation::SelectActive {
            account_id: desktop_id,
        },
    );
    assert_eq!(
        accounts
            .active_projection("cursor")
            .unwrap()
            .unwrap()
            .output
            .plan
            .as_deref(),
        Some("cursor-desktop")
    );
    let _ = std::fs::remove_dir_all(directory);
}
