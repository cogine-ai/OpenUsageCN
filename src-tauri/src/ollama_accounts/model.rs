use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub(crate) enum Primary {
    #[default]
    Legacy,
    None,
    Connection {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Clone, Deserialize)]
pub(super) struct VerifiedIdentity {
    pub fingerprint: String,
    #[serde(flatten)]
    pub display: DisplayIdentity,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record {
    pub connection_id: String,
    pub label: String,
    pub identity: DisplayIdentity,
    pub identity_fingerprint: String,
    pub api_key: String,
    pub revision: u64,
    pub snapshot: Option<PluginOutput>,
    pub last_updated_at: Option<String>,
    pub error: Option<AccountError>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredAccounts {
    pub version: u32,
    pub revision: u64,
    #[serde(default)]
    pub projection_revision: u64,
    #[serde(default)]
    pub legacy: LegacyRecord,
    pub primary: Primary,
    pub connections: Vec<Record>,
}

impl Default for StoredAccounts {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            projection_revision: 0,
            legacy: LegacyRecord::default(),
            primary: Primary::Legacy,
            connections: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountError {
    pub code: String,
    pub message: String,
}

/// Independent old-connection usage. Credentials remain in providers.json or the environment.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyRecord {
    pub revision: u64,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub configured: bool,
    pub configuration_generation: Option<String>,
    pub snapshot: Option<PluginOutput>,
    pub last_updated_at: Option<String>,
    pub error: Option<AccountError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyView {
    pub source: String,
    pub configured: bool,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<PluginOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AccountError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionView {
    pub connection_id: String,
    pub label: String,
    pub identity: DisplayIdentity,
    pub key_hint: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<PluginOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AccountError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountsView {
    pub revision: u64,
    pub primary: Primary,
    pub connections: Vec<ConnectionView>,
    pub legacy: LegacyView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerificationView {
    pub verification_id: String,
    pub identity: DisplayIdentity,
    pub key_hint: String,
    pub different_account: bool,
    pub same_account: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Operation {
    SelectPrimary {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
    UseLegacy,
    RefreshLegacy,
    Rename {
        #[serde(rename = "connectionId")]
        connection_id: String,
        label: String,
    },
    Remove {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
    Refresh {
        #[serde(rename = "connectionId")]
        connection_id: Option<String>,
    },
}

#[derive(Deserialize)]
pub(super) struct AccountProbe {
    pub identity: VerifiedIdentity,
    pub plan: Option<String>,
    pub lines: Vec<MetricLine>,
}

pub(super) fn key_hint(key: &str) -> String {
    // Short keys must never be returned in full, including via their suffix.
    if key.chars().count() <= 8 {
        return "••••".to_string();
    }
    key.chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

impl StoredAccounts {
    pub(super) fn view(&self) -> AccountsView {
        AccountsView {
            revision: self.revision,
            primary: self.primary.clone(),
            legacy: LegacyView {
                source: if self.legacy.source.is_empty() {
                    "cookie".into()
                } else {
                    self.legacy.source.clone()
                },
                configured: self.legacy.configured,
                revision: self.legacy.revision,
                snapshot: self.legacy.snapshot.clone(),
                last_updated_at: self.legacy.last_updated_at.clone(),
                error: self.legacy.error.clone(),
            },
            connections: self
                .connections
                .iter()
                .map(|r| ConnectionView {
                    connection_id: r.connection_id.clone(),
                    label: r.label.clone(),
                    identity: r.identity.clone(),
                    key_hint: key_hint(&r.api_key),
                    revision: r.revision,
                    plan: r.snapshot.as_ref().and_then(|s| s.plan.clone()),
                    snapshot: r.snapshot.clone(),
                    last_updated_at: r.last_updated_at.clone(),
                    error: r.error.clone(),
                })
                .collect(),
        }
    }
}
