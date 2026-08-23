use super::*;
use crate::plugin_engine::runtime::PluginOutput;
use crate::provider_accounts::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};

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
            lines: Vec::new(),
            icon_url: String::new(),
        })
    }

    fn output_metadata(&self) -> (String, String) {
        ("Cursor".to_string(), String::new())
    }
}

fn test_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "openusage-account-projection-{label}-{}",
        uuid::Uuid::new_v4()
    ))
}

fn output(name: &str) -> PluginOutput {
    PluginOutput {
        provider_id: "cursor".to_string(),
        display_name: name.to_string(),
        plan: Some("Pro".to_string()),
        lines: Vec::new(),
        icon_url: String::new(),
    }
}

fn wait_for_cache_writer_idle() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        let state = cache_state().lock().unwrap();
        if !state.flush_scheduled && state.dirty_generation == state.flushed_generation {
            return;
        }
        drop(state);
        assert!(
            std::time::Instant::now() < deadline,
            "debounced cache writer did not return to idle"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
#[serial_test::serial]
fn account_projection_force_replaces_and_removes_a_provider_snapshot() {
    let directory = test_dir("replace");
    std::fs::create_dir_all(&directory).unwrap();
    init(&directory, vec!["cursor".to_string()], "test".to_string());
    let old_started_at = time::OffsetDateTime::parse(
        "2026-03-26T08:15:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    cache_successful_output(&output("Old Cursor"), old_started_at);
    record_probe_error("cursor", "old account failed");
    flush_cache().unwrap();

    let replacement_started_at = time::OffsetDateTime::parse(
        "2026-03-25T08:15:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    replace_account_projection(
        "cursor",
        Some((&output("Selected Cursor"), replacement_started_at)),
    )
    .unwrap();
    assert_eq!(
        snapshot_for_provider("cursor").unwrap().display_name,
        "Selected Cursor"
    );
    assert_eq!(
        load_cache(&directory)["cursor"].display_name,
        "Selected Cursor"
    );

    record_probe_error("cursor", "selected account failed");
    replace_account_projection("cursor", None).unwrap();
    assert!(snapshot_for_provider("cursor").is_none());
    assert!(!load_cache(&directory).contains_key("cursor"));
    assert!(!cache_state().lock().unwrap().errors.contains_key("cursor"));
    wait_for_cache_writer_idle();
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
#[serial_test::serial]
fn unavailable_provider_accounts_preserve_existing_account_projection() {
    let directory = test_dir("unavailable");
    std::fs::create_dir_all(&directory).unwrap();
    init(&directory, vec!["cursor".to_string()], "test".to_string());
    let started_at = time::OffsetDateTime::parse(
        "2026-03-26T08:15:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    cache_successful_output(&output("Previous Cursor"), started_at);
    flush_cache().unwrap();

    let accounts = ProviderAccounts::unavailable("provider account storage is damaged");
    let error = crate::sync_active_account_projection(&accounts, "cursor")
        .expect_err("an unavailable registry must not become an empty projection");

    assert!(error.contains("Account data is unavailable"));
    assert!(error.contains("Correlation ID:"));
    assert_eq!(
        snapshot_for_provider("cursor").unwrap().display_name,
        "Previous Cursor"
    );
    assert_eq!(
        load_cache(&directory)["cursor"].display_name,
        "Previous Cursor"
    );

    wait_for_cache_writer_idle();
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
#[serial_test::serial]
fn damaged_selected_snapshot_clears_the_previous_accounts_v1_projection() {
    let directory = test_dir("damaged-selected");
    std::fs::create_dir_all(&directory).unwrap();
    init(&directory, vec!["cursor".to_string()], "test".to_string());
    let accounts = ProviderAccounts::with_store([62_u8; 32], &directory).unwrap();
    accounts.register_adapter("cursor", Box::new(TwoAccountProjectionAdapter));
    let refreshed = accounts.perform("cursor", ProviderOperation::RefreshActive);
    assert_eq!(refreshed.status, OperationStatus::Succeeded);
    let cli_id = refreshed
        .view
        .accounts
        .iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id
        .clone();

    let desktop_probe = accounts.prepare_active_probe("cursor").unwrap();
    accounts
        .publish_active_probe(desktop_probe, |_, _| {})
        .unwrap();
    crate::sync_active_account_projection(&accounts, "cursor").unwrap();
    assert_eq!(
        snapshot_for_provider("cursor").unwrap().plan.as_deref(),
        Some("cursor-desktop")
    );

    std::fs::write(
        directory.join("provider-account-snapshots.json"),
        "{damaged account snapshots",
    )
    .unwrap();
    let selected = accounts.perform(
        "cursor",
        ProviderOperation::SelectActive { account_id: cli_id },
    );
    assert_eq!(selected.status, OperationStatus::Succeeded);

    let error = crate::sync_active_account_projection(&accounts, "cursor")
        .expect_err("a damaged selected snapshot must fail closed");
    assert_eq!(error, "provider account snapshot storage is damaged");
    assert!(snapshot_for_provider("cursor").is_none());
    flush_cache().unwrap();
    assert!(!load_cache(&directory).contains_key("cursor"));

    wait_for_cache_writer_idle();
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
#[serial_test::serial]
fn invalid_selected_snapshot_timestamp_clears_the_previous_accounts_v1_projection() {
    let directory = test_dir("invalid-selected-timestamp");
    std::fs::create_dir_all(&directory).unwrap();
    init(&directory, vec!["cursor".to_string()], "test".to_string());
    let accounts = ProviderAccounts::with_store([63_u8; 32], &directory).unwrap();
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

    let mut account_snapshots = serde_json::Map::new();
    account_snapshots.insert(
        desktop_id,
        serde_json::json!({
            "displayName": "Cursor",
            "plan": "cursor-desktop",
            "lines": [],
            "startedAt": "2026-03-26T08:15:00Z",
            "fetchedAt": "2026-03-26T08:15:30Z"
        }),
    );
    account_snapshots.insert(
        cli_id.clone(),
        serde_json::json!({
            "displayName": "Cursor",
            "plan": "cursor-cli",
            "lines": [],
            "startedAt": "not-a-timestamp",
            "fetchedAt": "2026-03-26T08:15:30Z"
        }),
    );
    let snapshots = serde_json::json!({
        "version": 1,
        "providers": { "cursor": account_snapshots }
    });
    std::fs::write(
        directory.join("provider-account-snapshots.json"),
        serde_json::to_string(&snapshots).unwrap(),
    )
    .unwrap();
    crate::sync_active_account_projection(&accounts, "cursor").unwrap();
    assert_eq!(
        snapshot_for_provider("cursor").unwrap().plan.as_deref(),
        Some("cursor-desktop")
    );

    let selected = accounts.perform(
        "cursor",
        ProviderOperation::SelectActive { account_id: cli_id },
    );
    assert_eq!(selected.status, OperationStatus::Succeeded);
    let error = crate::sync_active_account_projection(&accounts, "cursor")
        .expect_err("an invalid selected timestamp must fail closed");
    assert_eq!(error, "provider account snapshot timestamp is invalid");
    assert!(snapshot_for_provider("cursor").is_none());
    flush_cache().unwrap();
    assert!(!load_cache(&directory).contains_key("cursor"));

    wait_for_cache_writer_idle();
    let _ = std::fs::remove_dir_all(directory);
}
