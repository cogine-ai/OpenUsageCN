use serde::{Deserialize, Serialize};

pub(crate) type AccountId = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "accountId", rename_all = "camelCase")]
pub(crate) enum AccountSelection {
    Auto,
    Pinned(AccountId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionKind {
    Desktop,
    Cli,
    Chrome,
    Arc,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ObservedConnection {
    pub identity_namespace: String,
    pub normalized_identity: String,
    pub connection_key: String,
    pub connection_kind: ConnectionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceStatus {
    Available,
    Absent,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceOutcome {
    pub source_key: String,
    pub status: SourceStatus,
}

impl SourceOutcome {
    pub(crate) fn new(source_key: &str, status: SourceStatus) -> Self {
        Self {
            source_key: source_key.to_string(),
            status,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DiscoveryReport {
    pub observations: Vec<ObservedConnection>,
    pub source_outcomes: Vec<SourceOutcome>,
    pub default_connection_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ProviderOperation {
    RefreshActive,
    SelectActive {
        #[serde(rename = "accountId")]
        account_id: AccountId,
    },
    FollowDefaultConnection,
    RenameAccount {
        #[serde(rename = "accountId")]
        account_id: AccountId,
        label: String,
    },
    AttachBrowserCandidate {
        #[serde(rename = "candidateId")]
        candidate_id: String,
    },
    DetachConnection {
        #[serde(rename = "accountId")]
        account_id: AccountId,
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStatus {
    Succeeded,
    Partial,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSummary {
    pub account_id: AccountId,
    pub label: String,
    pub connection_kinds: Vec<ConnectionKind>,
    pub selected: bool,
    pub stale: bool,
    pub connections: Vec<ConnectionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionSummary {
    pub connection_id: String,
    pub kind: ConnectionKind,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAccountView {
    pub provider_id: String,
    pub selection: AccountSelection,
    pub active_account_id: Option<AccountId>,
    pub accounts: Vec<AccountSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistence_warning: Option<ProviderPersistenceWarning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enrichment_warning: Option<ProviderEnrichmentWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderPersistenceWarning {
    pub code: String,
    pub message: String,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderEnrichmentWarning {
    pub code: String,
    pub message: String,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAccountViewChanged {
    pub provider_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOperationReceipt {
    pub operation_id: String,
    pub status: OperationStatus,
    pub source_outcomes: Vec<SourceOutcome>,
    pub view: ProviderAccountView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProviderOperationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOperationError {
    pub code: String,
    pub message: String,
}
