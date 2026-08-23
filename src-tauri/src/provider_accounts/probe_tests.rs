use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use std::sync::{Arc, Mutex};

fn single_connection_report(identity: &str) -> DiscoveryReport {
    DiscoveryReport {
        observations: vec![ObservedConnection {
            identity_namespace: "cursor-sub-v1".to_string(),
            normalized_identity: identity.to_string(),
            connection_key: "cursor-desktop".to_string(),
            connection_kind: ConnectionKind::Desktop,
        }],
        source_outcomes: vec![SourceOutcome::new(
            "cursor-desktop",
            SourceStatus::Available,
        )],
        default_connection_key: Some("cursor-desktop".to_string()),
    }
}

struct ProbeRecordingAdapter {
    probed_connection: Arc<Mutex<Option<String>>>,
}

impl ProviderAccountAdapter for ProbeRecordingAdapter {
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
        *self.probed_connection.lock().unwrap() = Some(connection_key.to_string());
        Ok(PluginOutput {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            plan: None,
            lines: vec![MetricLine::Text {
                label: "Connection".to_string(),
                value: connection_key.to_string(),
                color: None,
                subtitle: None,
            }],
            icon_url: String::new(),
        })
    }
}

#[test]
fn pinned_account_probe_uses_only_that_accounts_connection() {
    let probed_connection = Arc::new(Mutex::new(None));
    let accounts = ProviderAccounts::in_memory([33_u8; 32]);
    accounts.register_adapter(
        "cursor",
        Box::new(ProbeRecordingAdapter {
            probed_connection: Arc::clone(&probed_connection),
        }),
    );
    let refreshed = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let cli_account_id = refreshed
        .view
        .accounts
        .iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .unwrap()
        .account_id
        .clone();
    assert_eq!(
        accounts
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: cli_account_id,
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    let output = accounts.run_active_probe("cursor").expect("probe succeeds");

    assert_eq!(
        probed_connection.lock().unwrap().as_deref(),
        Some("cursor-cli")
    );
    match &output.lines[0] {
        MetricLine::Text { value, .. } => assert_eq!(value, "cursor-cli"),
        other => panic!("expected connection text, got {other:?}"),
    }
}

struct MutableAccountAdapter {
    observed: Arc<Mutex<DiscoveryReport>>,
}

impl ProviderAccountAdapter for MutableAccountAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(self
            .observed
            .lock()
            .expect("observed account poisoned")
            .clone())
    }
}

#[test]
fn source_login_change_keeps_the_pinned_account_stale_and_reconciles_the_new_identity() {
    let observed = Arc::new(Mutex::new(single_connection_report("auth0|original-user")));
    let accounts = ProviderAccounts::in_memory([35_u8; 32]);
    accounts.register_adapter(
        "cursor",
        Box::new(MutableAccountAdapter {
            observed: Arc::clone(&observed),
        }),
    );
    let original = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let original_account_id = original.view.accounts[0].account_id.clone();
    assert_eq!(
        accounts
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: original_account_id.clone(),
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    *observed.lock().unwrap() = single_connection_report("auth0|new-user");
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );

    let view = accounts.view("cursor").unwrap();
    assert_eq!(view.active_account_id, Some(original_account_id.clone()));
    assert_eq!(view.accounts.len(), 2);
    assert!(
        view.accounts
            .iter()
            .find(|account| account.account_id == original_account_id)
            .unwrap()
            .stale
    );
    assert!(view.accounts.iter().any(|account| !account.stale));
    assert_eq!(
        accounts.run_active_probe("cursor").err().as_deref(),
        Some("The selected account has no available connection.")
    );
}

struct RotatingCredentialAdapter {
    generation: Arc<Mutex<String>>,
}

struct IdentitySwitchingProbeAdapter {
    observed: Arc<Mutex<DiscoveryReport>>,
}

impl ProviderAccountAdapter for IdentitySwitchingProbeAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(self.observed.lock().unwrap().clone())
    }

    fn probe_connection(
        &self,
        _connection_key: &str,
        _credential_generation: &str,
    ) -> Result<PluginOutput, String> {
        *self.observed.lock().unwrap() = single_connection_report("auth0|account-b");
        Ok(PluginOutput {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            plan: Some("Pro".to_string()),
            lines: vec![],
            icon_url: String::new(),
        })
    }
}

#[test]
fn a_local_identity_change_during_probe_is_rejected() {
    let observed = Arc::new(Mutex::new(single_connection_report("auth0|account-a")));
    let accounts = ProviderAccounts::in_memory([36_u8; 32]);
    accounts.register_adapter(
        "cursor",
        Box::new(IdentitySwitchingProbeAdapter {
            observed: Arc::clone(&observed),
        }),
    );
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );

    assert_eq!(
        accounts.prepare_active_probe("cursor").err().as_deref(),
        Some("Account identity changed during refresh. Try again.")
    );
}

impl ProviderAccountAdapter for RotatingCredentialAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(single_connection_report("auth0|cursor-user"))
    }

    fn credential_generation(&self, _connection_key: &str) -> Result<String, String> {
        Ok(self.generation.lock().unwrap().clone())
    }

    fn probe_connection(
        &self,
        _connection_key: &str,
        _credential_generation: &str,
    ) -> Result<PluginOutput, String> {
        *self.generation.lock().unwrap() = "generation-b".to_string();
        Ok(PluginOutput {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            plan: None,
            lines: vec![MetricLine::Text {
                label: "Requests".to_string(),
                value: "1".to_string(),
                color: None,
                subtitle: None,
            }],
            icon_url: String::new(),
        })
    }
}

#[test]
fn a_credential_generation_change_rejects_the_probe_output() {
    let generation = Arc::new(Mutex::new("generation-a".to_string()));
    let accounts = ProviderAccounts::in_memory([37_u8; 32]);
    accounts.register_adapter(
        "cursor",
        Box::new(RotatingCredentialAdapter {
            generation: Arc::clone(&generation),
        }),
    );
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );

    assert_eq!(
        accounts.run_active_probe("cursor").err().as_deref(),
        Some("Account credentials changed during refresh. Try again.")
    );
}
