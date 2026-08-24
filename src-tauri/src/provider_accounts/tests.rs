use super::{
    AccountSelection, ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus,
    ProviderAccountAdapter, ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use std::sync::{Arc, Mutex};

struct OneAccountAdapter;

impl ProviderAccountAdapter for OneAccountAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(single_connection_report(
            "auth0|cursor-user",
            "cursor-desktop",
            ConnectionKind::Desktop,
        ))
    }
}

fn single_connection_report(
    identity: &str,
    connection_key: &str,
    connection_kind: ConnectionKind,
) -> DiscoveryReport {
    DiscoveryReport {
        observations: vec![ObservedConnection {
            identity_namespace: "cursor-sub-v1".to_string(),
            normalized_identity: identity.to_string(),
            connection_key: connection_key.to_string(),
            connection_kind,
        }],
        source_outcomes: vec![SourceOutcome::new(connection_key, SourceStatus::Available)],
        default_connection_key: Some(connection_key.to_string()),
    }
}

#[test]
fn refresh_discovers_an_account_through_the_public_view() {
    let accounts = ProviderAccounts::in_memory([7_u8; 32]);
    accounts.register_adapter("cursor", Box::new(OneAccountAdapter));

    let receipt = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let view = accounts.view("cursor").expect("view succeeds");

    assert_eq!(receipt.status, OperationStatus::Succeeded);
    assert_eq!(view.selection, AccountSelection::Auto);
    assert_eq!(view.accounts.len(), 1);
    assert_eq!(view.accounts[0].label, "Account 1");
    assert_eq!(
        view.accounts[0].connection_kinds,
        vec![ConnectionKind::Desktop]
    );
    assert!(view.accounts[0].selected);
    assert_eq!(
        view.active_account_id,
        Some(view.accounts[0].account_id.clone())
    );
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
fn pinned_selection_does_not_follow_a_different_default_identity() {
    let observed = Arc::new(Mutex::new(single_connection_report(
        "auth0|desktop-user",
        "cursor-desktop",
        ConnectionKind::Desktop,
    )));
    let accounts = ProviderAccounts::in_memory([9_u8; 32]);
    accounts.register_adapter(
        "cursor",
        Box::new(MutableAccountAdapter {
            observed: Arc::clone(&observed),
        }),
    );
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let desktop_account_id = accounts.view("cursor").unwrap().accounts[0]
        .account_id
        .clone();

    *observed.lock().unwrap() =
        single_connection_report("auth0|cli-user", "cursor-cli", ConnectionKind::Cli);
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        accounts
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: desktop_account_id.clone(),
                },
            )
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );

    let view = accounts.view("cursor").unwrap();
    assert_eq!(
        view.selection,
        AccountSelection::Pinned(desktop_account_id.clone())
    );
    assert_eq!(view.active_account_id, Some(desktop_account_id));
    assert_eq!(view.accounts.len(), 2);
}

#[test]
fn following_default_selects_the_latest_default_connection() {
    let observed = Arc::new(Mutex::new(single_connection_report(
        "auth0|desktop-user",
        "cursor-desktop",
        ConnectionKind::Desktop,
    )));
    let accounts = ProviderAccounts::in_memory([11_u8; 32]);
    accounts.register_adapter(
        "cursor",
        Box::new(MutableAccountAdapter {
            observed: Arc::clone(&observed),
        }),
    );
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let desktop_account_id = accounts.view("cursor").unwrap().accounts[0]
        .account_id
        .clone();
    assert_eq!(
        accounts
            .perform(
                "cursor",
                ProviderOperation::SelectActive {
                    account_id: desktop_account_id,
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    *observed.lock().unwrap() =
        single_connection_report("auth0|cli-user", "cursor-cli", ConnectionKind::Cli);
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let cli_account_id = accounts
        .view("cursor")
        .unwrap()
        .accounts
        .into_iter()
        .find(|account| account.connection_kinds == vec![ConnectionKind::Cli])
        .expect("CLI account is retained")
        .account_id;

    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::FollowDefaultConnection)
            .status,
        OperationStatus::Succeeded
    );

    let view = accounts.view("cursor").unwrap();
    assert_eq!(view.selection, AccountSelection::Auto);
    assert_eq!(view.active_account_id, Some(cli_account_id));
}

struct DesktopAndCliAdapter;

impl ProviderAccountAdapter for DesktopAndCliAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![
                ObservedConnection {
                    identity_namespace: "cursor-sub-v1".to_string(),
                    normalized_identity: "auth0|shared-user".to_string(),
                    connection_key: "cursor-desktop".to_string(),
                    connection_kind: ConnectionKind::Desktop,
                },
                ObservedConnection {
                    identity_namespace: "cursor-sub-v1".to_string(),
                    normalized_identity: "auth0|shared-user".to_string(),
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
fn same_identity_from_desktop_and_cli_merges_without_exposing_the_subject() {
    let accounts = ProviderAccounts::in_memory([13_u8; 32]);
    accounts.register_adapter("cursor", Box::new(DesktopAndCliAdapter));

    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let view = accounts.view("cursor").unwrap();

    assert_eq!(view.accounts.len(), 1);
    assert_eq!(
        view.accounts[0].connection_kinds,
        vec![ConnectionKind::Desktop, ConnectionKind::Cli]
    );
    let serialized = serde_json::to_string(&view).unwrap();
    assert!(!serialized.contains("auth0|shared-user"));
    assert!(!serialized.contains("cursor-sub-v1"));
}

#[test]
fn rename_account_trims_a_valid_user_label() {
    let accounts = ProviderAccounts::in_memory([15_u8; 32]);
    accounts.register_adapter("cursor", Box::new(OneAccountAdapter));
    assert_eq!(
        accounts
            .perform("cursor", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let account_id = accounts.view("cursor").unwrap().accounts[0]
        .account_id
        .clone();

    assert_eq!(
        accounts
            .perform(
                "cursor",
                ProviderOperation::RenameAccount {
                    account_id,
                    label: "  Work Cursor  ".to_string(),
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    assert_eq!(
        accounts.view("cursor").unwrap().accounts[0].label,
        "Work Cursor"
    );
}

struct UnavailableAdapter;

impl ProviderAccountAdapter for UnavailableAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Err("auth0|secret-sub must not escape".to_string())
    }
}

#[test]
fn expected_refresh_failure_returns_a_nonsecret_failed_receipt() {
    let accounts = ProviderAccounts::in_memory([17_u8; 32]);
    accounts.register_adapter("cursor", Box::new(UnavailableAdapter));

    let receipt = accounts.perform("cursor", ProviderOperation::RefreshActive);

    assert_eq!(receipt.status, OperationStatus::Failed);
    assert_eq!(receipt.error.as_ref().unwrap().code, "refreshFailed");
    assert_eq!(
        receipt.error.as_ref().unwrap().message,
        "Cursor account refresh failed. Try again."
    );
    assert!(!receipt.operation_id.is_empty());
    let serialized = serde_json::to_string(&receipt).unwrap();
    assert!(!serialized.contains("auth0|secret-sub"));
}

struct PartialDiscoveryAdapter;

impl ProviderAccountAdapter for PartialDiscoveryAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        let mut report = single_connection_report(
            "auth0|partial-user",
            "cursor-desktop",
            ConnectionKind::Desktop,
        );
        report
            .source_outcomes
            .push(SourceOutcome::new("cursor-cli", SourceStatus::Unavailable));
        Ok(report)
    }
}

#[test]
fn partial_refresh_enumerates_every_requested_source() {
    let accounts = ProviderAccounts::in_memory([19_u8; 32]);
    accounts.register_adapter("cursor", Box::new(PartialDiscoveryAdapter));

    let receipt = accounts.perform("cursor", ProviderOperation::RefreshActive);

    assert_eq!(receipt.status, OperationStatus::Partial);
    assert_eq!(receipt.source_outcomes.len(), 2);
    assert_eq!(receipt.source_outcomes[0].source_key, "cursor-desktop");
    assert_eq!(receipt.source_outcomes[0].status, SourceStatus::Available);
    assert_eq!(receipt.source_outcomes[1].source_key, "cursor-cli");
    assert_eq!(receipt.source_outcomes[1].status, SourceStatus::Unavailable);
}

struct MissingLocalSourcesAdapter;

impl ProviderAccountAdapter for MissingLocalSourcesAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: Vec::new(),
            source_outcomes: vec![
                SourceOutcome::new("cursor-desktop", SourceStatus::Absent),
                SourceOutcome::new("cursor-cli", SourceStatus::Unavailable),
            ],
            default_connection_key: None,
        })
    }
}

#[test]
fn failed_refresh_retains_nonsecret_requested_source_outcomes() {
    let accounts = ProviderAccounts::in_memory([21_u8; 32]);
    accounts.register_adapter("cursor", Box::new(MissingLocalSourcesAdapter));

    let receipt = accounts.perform("cursor", ProviderOperation::RefreshActive);

    assert_eq!(receipt.status, OperationStatus::Failed);
    assert_eq!(receipt.source_outcomes.len(), 2);
    assert_eq!(receipt.source_outcomes[0].status, SourceStatus::Absent);
    assert_eq!(receipt.source_outcomes[1].status, SourceStatus::Unavailable);
    assert_eq!(receipt.error.as_ref().unwrap().code, "refreshFailed");
}

#[test]
fn successful_operations_produce_a_nonsecret_monotonic_revision_event() {
    let accounts = ProviderAccounts::in_memory([31_u8; 32]);
    accounts.register_adapter("cursor", Box::new(OneAccountAdapter));

    let first_receipt = accounts.perform("cursor", ProviderOperation::RefreshActive);
    let first_event = accounts
        .changed_event("cursor", &first_receipt)
        .expect("successful mutation emits a revision");
    let second_receipt = accounts.perform(
        "cursor",
        ProviderOperation::RenameAccount {
            account_id: first_receipt.view.accounts[0].account_id.clone(),
            label: "Primary".to_string(),
        },
    );
    let second_event = accounts
        .changed_event("cursor", &second_receipt)
        .expect("second mutation emits a revision");

    assert_eq!(first_event.revision, 1);
    assert_eq!(second_event.revision, 2);
    let value = serde_json::to_value(second_event).unwrap();
    assert_eq!(value["providerId"], "cursor");
    assert_eq!(value["revision"], 2);
    assert_eq!(value.as_object().unwrap().len(), 2);

    let failed = accounts.perform("unknown", ProviderOperation::RefreshActive);
    assert!(accounts.changed_event("unknown", &failed).is_none());
}
