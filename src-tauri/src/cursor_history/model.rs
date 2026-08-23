use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq)]
pub(crate) enum RawNumber {
    Missing,
    Integer(i128),
    Decimal(f64),
    Invalid,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ScriptedTokenUsage {
    pub input_tokens: RawNumber,
    pub output_tokens: RawNumber,
    pub cache_write_tokens: RawNumber,
    pub cache_read_tokens: RawNumber,
    pub total_cents: RawNumber,
}

// Raw events deliberately have no Serialize/Deserialize or Debug implementation. The mapper
// consumes them; only CompleteHistory may cross a storage, log, or frontend boundary.
#[derive(Clone, PartialEq)]
pub(crate) struct ScriptedEvent {
    pub timestamp_ms: RawNumber,
    pub model_name: String,
    pub token_usage: Option<ScriptedTokenUsage>,
    pub charged_cents: RawNumber,
    pub owning_user: Option<String>,
    pub owning_team: Option<String>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ScriptedPage {
    pub page: u16,
    pub events: Vec<ScriptedEvent>,
    pub total_usage_events_count: Option<u64>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ScriptedHistory {
    pub account_id: String,
    pub from_ms: i64,
    pub to_ms: i64,
    pub fetched_at_ms: i64,
    pub time_zone: String,
    pub utc_offset_seconds: i32,
    pub requested_page_size: usize,
    pub pages: Vec<ScriptedPage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteHistory {
    pub account_id: String,
    pub buckets: Vec<ModelUsageBucket>,
    pub coverage: HistoryCoverage,
    pub totals: HistoryTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelUsageBucket {
    pub local_date: String,
    pub model_name: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub request_count: u64,
    pub known_list_cost_usd: Option<f64>,
    pub list_cost_coverage: ListCostCoverage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ListCostCoverage {
    Complete,
    Partial,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryCoverage {
    pub from_ms: i64,
    pub to_ms: i64,
    pub fetched_at_ms: i64,
    pub time_zone: String,
    pub complete: bool,
    pub scope: HistoryScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HistoryScope {
    SessionVisible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryTotals {
    pub metered_charged_usd: Option<f64>,
    pub metered_coverage: MeteredCoverage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MeteredCoverage {
    Complete,
    Incomplete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HistoryError {
    AuthenticationUnavailable,
    IdentityChanged,
    CredentialLeaseChanged,
    CredentialLeaseMismatch,
    Cancelled,
    Transport(super::TransportError),
    StorageRead,
    StorageWrite,
    StorageInvalid,
    InvalidStorageKey,
    IncompleteSnapshot,
    SnapshotAccountMismatch,
    SchedulerUnavailable,
    SchedulerClosed,
    UnsupportedProvider,
    ResultScopeChanged,
    NoPages,
    UnexpectedPageSize {
        actual: usize,
    },
    MissingPage {
        expected: u16,
        actual: u16,
    },
    PageLimitExceeded {
        actual: usize,
    },
    PageTooLarge {
        page: u16,
        actual: usize,
    },
    TotalCountDrift {
        expected: Option<u64>,
        actual: Option<u64>,
        page: u16,
    },
    FinalPageNotShort {
        page: u16,
    },
    RowsAfterFinalPage {
        page: u16,
    },
    CountMismatch {
        expected: u64,
        actual: u64,
    },
    InvalidWindow,
    InvalidTimeZoneOffset,
    MalformedTokenValue,
    TokenOverflow,
}
