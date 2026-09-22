use super::*;
use crate::plugin_engine::manifest::LoadedPlugin;
use crate::provider_accounts::{
    ConnectionKind, DiscoveryReport, ObservedConnection, ProviderAccountAdapter, ProviderAccounts,
    ProviderOperation, SourceOutcome, SourceStatus,
};

const PRIVATE_PATH: &str = "/Users/history-fixture/.codex/sessions/private.jsonl";
const PRIVATE_KEY: &str = "sk-history-fixture-private-123456789";

fn plugin(provider_id: &str, script: &str) -> LoadedPlugin {
    LoadedPlugin {
        manifest: serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": provider_id, "name": "Fixture", "version": "0.0.0",
            "entry": "plugin.js", "icon": "icon.svg", "lines": [],
        }))
        .unwrap(),
        plugin_dir: std::env::temp_dir(),
        entry_script: script.to_string(),
        icon_data_url: String::new(),
    }
}

fn failing_plugin(provider_id: &str, message: &str) -> LoadedPlugin {
    plugin(
        provider_id,
        &format!(
            "globalThis.__openusage_plugin = {{ probeHistory() {{ throw {}; }} }};",
            serde_json::to_string(message).unwrap()
        ),
    )
}

fn assert_private_error_is_redacted(error: &str) {
    assert!(error.contains("History fixture failed"));
    assert!(error.contains("[PATH]"), "local path was not redacted");
    assert!(
        !error.contains(PRIVATE_PATH),
        "local path reached the frontend"
    );
    assert!(
        !error.contains(PRIVATE_KEY),
        "credential reached the frontend"
    );
}

#[test]
fn local_history_redacts_thrown_plugin_errors_before_returning_them() {
    let plugin = failing_plugin(
        "codex",
        &format!("History fixture failed: {PRIVATE_PATH}, token={PRIVATE_KEY}"),
    );
    let output = runtime::run_local_history(&plugin, &std::env::temp_dir(), "0.0.0", None);
    let error = local_history_snapshot("codex".to_string(), None, Ok(output))
        .err()
        .expect("history should fail");
    assert_private_error_is_redacted(&error);
}

struct FailingHistoryAdapter {
    message: String,
    runtime_error: bool,
}

impl ProviderAccountAdapter for FailingHistoryAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "claude-oauth-profile-v1".to_string(),
                normalized_identity: "history-fixture".to_string(),
                connection_key: "claude-oauth".to_string(),
                connection_kind: ConnectionKind::Cli,
            }],
            source_outcomes: vec![SourceOutcome::new("claude-oauth", SourceStatus::Available)],
            default_connection_key: Some("claude-oauth".to_string()),
        })
    }

    fn probe_local_history(
        &self,
        key: &str,
        generation: &str,
    ) -> Result<runtime::PluginOutput, String> {
        if self.runtime_error {
            Ok(runtime::run_local_history(
                &failing_plugin("claude", &self.message),
                &std::env::temp_dir(),
                "0.0.0",
                Some((key, generation)),
            ))
        } else {
            Err(self.message.clone())
        }
    }
}

#[test]
fn local_history_redacts_account_scoped_adapter_and_plugin_errors() {
    for runtime_error in [false, true] {
        let accounts = ProviderAccounts::in_memory([82; 32]);
        accounts.register_adapter(
            "claude",
            Box::new(FailingHistoryAdapter {
                message: format!("History fixture failed: {PRIVATE_PATH}, token={PRIVATE_KEY}"),
                runtime_error,
            }),
        );
        let account_id = accounts
            .perform("claude", ProviderOperation::RefreshActive)
            .view
            .active_account_id
            .expect("fixture account should be selected");
        let result = accounts.run_local_history("claude", &account_id);
        let error = local_history_snapshot("claude".to_string(), Some(account_id), result)
            .err()
            .expect("history should fail");
        assert_private_error_is_redacted(&error);
    }
}

#[test]
fn local_history_timeout_keeps_its_friendly_error() {
    let error = local_history_snapshot(
        "codex".to_string(),
        None,
        Err(format!("probe timed out: {PRIVATE_PATH}")),
    )
    .err()
    .expect("history should fail");
    assert_eq!(error, "本地用量读取超时，请稍后重试。");
}

#[test]
fn local_history_rejects_quota_style_rows_before_returning_them_to_the_ui() {
    let plugin = plugin(
        "codex",
        r#"globalThis.__openusage_plugin = {
        probeHistory: () => ({
            lines: [{ type: "progress", label: "Session", used: 10, limit: 100, format: { kind: "percent" } }]
        })
    };"#,
    );
    let output = runtime::run_local_history(&plugin, &std::env::temp_dir(), "0.0.0", None);
    let error = local_history_snapshot("codex".to_string(), None, Ok(output))
        .err()
        .expect("history should reject quota rows");
    assert_eq!(error, "本地用量返回了不支持的数据，请更新插件后重试。");
}

#[test]
fn local_history_returns_valid_history_without_quota_rows() {
    let plugin = plugin(
        "codex",
        r#"globalThis.__openusage_plugin = {
        probeHistory: () => ({ lines: [{ type: "text", label: "Today", value: "12K" }] })
    };"#,
    );
    let output = runtime::run_local_history(&plugin, &std::env::temp_dir(), "0.0.0", None);
    let snapshot = local_history_snapshot("codex".to_string(), None, Ok(output)).unwrap();
    assert_eq!(snapshot.provider_id, "codex");
    assert!(snapshot.account_id.is_none());
    assert!(!snapshot.fetched_at.is_empty());
    assert!(
        matches!(&snapshot.lines[..], [runtime::MetricLine::Text { label, value, .. }] if label == "Today" && value == "12K")
    );
}
