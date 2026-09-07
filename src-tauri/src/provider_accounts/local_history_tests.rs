use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, ProviderAccountAdapter, ProviderAccounts,
    ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use std::sync::{Arc, Mutex};

type HistoryHook = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

struct HistoryAdapter {
    generation: Arc<Mutex<String>>,
    identity: Arc<Mutex<String>>,
    on_history: HistoryHook,
}

fn output(label: &str) -> PluginOutput {
    PluginOutput {
        provider_id: "claude".to_string(),
        display_name: "Claude".to_string(),
        plan: None,
        lines: vec![MetricLine::Text {
            label: label.to_string(),
            value: "fixture".to_string(),
            color: None,
            subtitle: None,
        }],
        icon_url: String::new(),
    }
}

impl ProviderAccountAdapter for HistoryAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "claude-oauth-profile-v1".to_string(),
                normalized_identity: self.identity.lock().unwrap().clone(),
                connection_key: "claude-oauth".to_string(),
                connection_kind: ConnectionKind::Cli,
            }],
            source_outcomes: vec![SourceOutcome::new("claude-oauth", SourceStatus::Available)],
            default_connection_key: Some("claude-oauth".to_string()),
        })
    }

    fn credential_generation(&self, _: &str) -> Result<String, String> {
        Ok(self.generation.lock().unwrap().clone())
    }

    fn probe_connection(&self, _: &str, _: &str) -> Result<PluginOutput, String> {
        panic!("history must not request quota")
    }

    fn probe_local_history(&self, key: &str, generation: &str) -> Result<PluginOutput, String> {
        assert_eq!(key, "claude-oauth");
        assert_eq!(generation, *self.generation.lock().unwrap());
        if let Some(hook) = self.on_history.lock().unwrap().take() {
            hook();
        }
        Ok(output("Today"))
    }
}

struct Fixture {
    accounts: Arc<ProviderAccounts>,
    account_id: String,
    generation: Arc<Mutex<String>>,
    identity: Arc<Mutex<String>>,
    hook: HistoryHook,
}

fn fixture(accounts: ProviderAccounts) -> Fixture {
    let accounts = Arc::new(accounts);
    let generation = Arc::new(Mutex::new("generation-one".to_string()));
    let identity = Arc::new(Mutex::new("account-one".to_string()));
    let hook = Arc::new(Mutex::new(None));
    accounts.register_adapter(
        "claude",
        Box::new(HistoryAdapter {
            generation: Arc::clone(&generation),
            identity: Arc::clone(&identity),
            on_history: Arc::clone(&hook),
        }),
    );
    let receipt = accounts.perform("claude", ProviderOperation::RefreshActive);
    let account_id = receipt.view.active_account_id.expect("active account");
    Fixture {
        accounts,
        account_id,
        generation,
        identity,
        hook,
    }
}

#[test]
#[serial_test::serial]
fn local_history_leaves_quota_snapshot_and_its_timestamp_unchanged() {
    let dir =
        std::env::temp_dir().join(format!("openusage-local-history-{}", uuid::Uuid::new_v4()));
    let fixture = fixture(ProviderAccounts::with_store([41; 32], &dir).unwrap());
    let store = fixture.accounts.snapshot_store.as_ref().unwrap();
    let stamp = "2026-09-07T00:00:00Z";
    store
        .save(
            "claude",
            &fixture.account_id,
            &output("Quota"),
            stamp,
            stamp,
        )
        .unwrap();

    let history = fixture
        .accounts
        .run_local_history("claude", &fixture.account_id)
        .unwrap();

    assert!(matches!(&history.lines[0], MetricLine::Text { label, .. } if label == "Today"));
    let stored = store.load("claude", &fixture.account_id).unwrap().unwrap();
    assert_eq!(stored.started_at, stamp);
    assert_eq!(stored.fetched_at, stamp);
    assert!(matches!(&stored.lines[0], MetricLine::Text { label, .. } if label == "Quota"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn credential_change_during_history_rejects_the_result() {
    let fixture = fixture(ProviderAccounts::in_memory([42; 32]));
    let generation = Arc::clone(&fixture.generation);
    *fixture.hook.lock().unwrap() = Some(Box::new(move || {
        *generation.lock().unwrap() = "generation-two".to_string();
    }));
    let error = fixture
        .accounts
        .run_local_history("claude", &fixture.account_id)
        .unwrap_err();
    assert!(error.contains("credentials changed"));
}

#[test]
fn identity_change_during_history_rejects_the_result() {
    let fixture = fixture(ProviderAccounts::in_memory([43; 32]));
    let identity = Arc::clone(&fixture.identity);
    *fixture.hook.lock().unwrap() = Some(Box::new(move || {
        *identity.lock().unwrap() = "account-two".to_string();
    }));
    let error = fixture
        .accounts
        .run_local_history("claude", &fixture.account_id)
        .unwrap_err();
    assert!(error.contains("identity changed"));
}

#[test]
fn account_selection_change_during_history_rejects_the_result() {
    let fixture = fixture(ProviderAccounts::in_memory([44; 32]));
    let accounts = Arc::clone(&fixture.accounts);
    *fixture.hook.lock().unwrap() = Some(Box::new(move || {
        accounts
            .providers
            .lock()
            .unwrap()
            .get_mut("claude")
            .unwrap()
            .active_account_id = None;
    }));
    let error = fixture
        .accounts
        .run_local_history("claude", &fixture.account_id)
        .unwrap_err();
    assert!(error.contains("selection changed"));
}

#[test]
fn a_browser_only_account_cannot_load_local_cli_history() {
    let fixture = fixture(ProviderAccounts::in_memory([45; 32]));
    fixture
        .accounts
        .providers
        .lock()
        .unwrap()
        .get_mut("claude")
        .unwrap()
        .accounts[0]
        .connections[0]
        .kind = ConnectionKind::Chrome;
    *fixture.hook.lock().unwrap() = Some(Box::new(|| panic!("history must not run")));
    let error = fixture
        .accounts
        .run_local_history("claude", &fixture.account_id)
        .unwrap_err();
    assert!(error.contains("CLI connection"));
}

#[test]
fn a_stale_requested_account_cannot_start_history() {
    let fixture = fixture(ProviderAccounts::in_memory([46; 32]));
    *fixture.hook.lock().unwrap() = Some(Box::new(|| panic!("history must not run")));
    let error = fixture
        .accounts
        .run_local_history("claude", "old-account")
        .unwrap_err();
    assert!(error.contains("selection changed"));
}

#[test]
#[serial_test::serial]
fn a_detach_in_another_process_rejects_the_completed_history() {
    let dir = std::env::temp_dir().join(format!(
        "openusage-local-history-detach-{}",
        uuid::Uuid::new_v4()
    ));
    let fixture = fixture(ProviderAccounts::with_store([47; 32], &dir).unwrap());
    let accounts = Arc::clone(&fixture.accounts);
    *fixture.hook.lock().unwrap() = Some(Box::new(move || {
        let mut detached = accounts
            .providers
            .lock()
            .unwrap()
            .get("claude")
            .unwrap()
            .clone();
        detached.accounts[0].connections[0].attached = false;
        detached.accounts[0].connections[0].attachment_revision += 1;
        accounts
            .registry_store
            .as_ref()
            .unwrap()
            .save_provider("claude", &detached)
            .unwrap();
    }));
    let error = fixture
        .accounts
        .run_local_history("claude", &fixture.account_id)
        .unwrap_err();
    assert!(error.contains("selection changed"));
    let _ = std::fs::remove_dir_all(dir);
}
