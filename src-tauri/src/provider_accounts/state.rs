use super::model::{
    AccountId, AccountSelection, AccountSummary, ConnectionKind, ProviderAccountView,
    ProviderPersistenceWarning, SourceOutcome,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderState {
    pub(super) selection: AccountSelection,
    #[serde(default)]
    pub(super) selection_revision: u64,
    pub(super) active_account_id: Option<AccountId>,
    pub(super) default_account_id: Option<AccountId>,
    #[serde(with = "super::account_records_serde")]
    pub(super) accounts: Vec<AccountRecord>,
}

impl Default for AccountSelection {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountRecord {
    pub(super) account_id: AccountId,
    pub(super) label: String,
    #[serde(default)]
    pub(super) label_revision: u64,
    pub(super) identity_namespace: String,
    pub(super) identity_fingerprint: String,
    pub(super) connections: Vec<ConnectionRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConnectionRecord {
    pub(super) connection_id: String,
    pub(super) connection_key: String,
    pub(super) kind: ConnectionKind,
    #[serde(default = "connection_attached_by_default")]
    pub(super) attached: bool,
    #[serde(default)]
    pub(super) attachment_revision: u64,
    #[serde(skip, default)]
    pub(super) available: bool,
    #[serde(skip, default)]
    pub(super) session_ref: Option<String>,
}

fn connection_attached_by_default() -> bool {
    true
}

pub(super) fn view_from_state(
    provider_id: &str,
    provider: &ProviderState,
    persistence_warning: Option<ProviderPersistenceWarning>,
) -> ProviderAccountView {
    let mut accounts = provider
        .accounts
        .iter()
        .map(|account| {
            let mut connection_kinds: Vec<_> = account
                .connections
                .iter()
                .filter(|connection| connection.attached)
                .map(|connection| connection.kind)
                .collect();
            connection_kinds.sort_unstable();
            connection_kinds.dedup();
            AccountSummary {
                account_id: account.account_id.clone(),
                label: account.label.clone(),
                connection_kinds,
                selected: provider.active_account_id.as_ref() == Some(&account.account_id),
                stale: !account
                    .connections
                    .iter()
                    .any(|connection| connection.attached && connection.available),
                connections: account
                    .connections
                    .iter()
                    .filter(|connection| connection.attached)
                    .map(|connection| super::model::ConnectionSummary {
                        connection_id: connection.connection_id.clone(),
                        kind: connection.kind,
                        available: connection.available,
                        profile_key: matches!(
                            connection.kind,
                            ConnectionKind::Chrome | ConnectionKind::Arc
                        )
                        .then(|| connection.connection_key.clone()),
                    })
                    .collect(),
            }
        })
        .collect::<Vec<_>>();
    accounts.sort_by(|left, right| left.label.cmp(&right.label));

    ProviderAccountView {
        provider_id: provider_id.to_string(),
        selection: provider.selection.clone(),
        active_account_id: provider.active_account_id.clone(),
        accounts,
        persistence_warning,
    }
}

pub(super) fn mark_connections_unavailable(
    provider: &mut ProviderState,
    outcomes: &[SourceOutcome],
) {
    for outcome in outcomes {
        for account in &mut provider.accounts {
            for connection in &mut account.connections {
                if connection.connection_key == outcome.source_key {
                    connection.available = false;
                }
            }
        }
    }
}

pub(super) fn empty_view(
    provider_id: &str,
    persistence_warning: Option<ProviderPersistenceWarning>,
) -> ProviderAccountView {
    ProviderAccountView {
        provider_id: provider_id.to_string(),
        selection: AccountSelection::Auto,
        active_account_id: None,
        accounts: Vec::new(),
        persistence_warning,
    }
}
