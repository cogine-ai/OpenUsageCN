mod account_records_serde;
mod browser_cursor_probe;
mod browser_operations;
mod browser_probe_operation;
mod claude_browser;
mod claude_enrichment;
mod claude_profile;
mod coordinator;
mod history_lease;
mod history_window;
mod identity;
mod keychain;
mod model;
mod operations;
mod plugin_adapter;
mod probe;
mod projection;
mod registry_store;
mod snapshot_store;
mod state;

pub(crate) use coordinator::ProviderAccounts;
#[cfg(test)]
pub(crate) use model::AccountSelection;
pub(crate) use model::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountView,
    ProviderOperation, ProviderOperationReceipt, SourceOutcome, SourceStatus,
};
pub(crate) use plugin_adapter::QuickJsAccountAdapter;
pub(crate) use probe::{ActiveAccountProbe, ProviderAccountAdapter};

#[cfg(test)]
mod browser_account_tests;
#[cfg(test)]
mod browser_cursor_probe_tests;
#[cfg(test)]
mod claude_browser_tests;
#[cfg(test)]
mod claude_enrichment_tests;
#[cfg(test)]
mod claude_profile_tests;
#[cfg(test)]
mod history_lease_tests;
#[cfg(test)]
mod plugin_adapter_claude_tests;
#[cfg(test)]
mod probe_tests;
#[cfg(test)]
mod projection_tests;
#[cfg(test)]
mod registry_race_tests;
#[cfg(test)]
mod registry_store_tests;
#[cfg(test)]
mod snapshot_store_tests;
#[cfg(test)]
mod tests;
