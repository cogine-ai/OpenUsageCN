mod aggregate;
mod credential;
mod fetcher;
mod model;
mod pagination;
mod scheduler;
mod service;
mod store;
mod transport;
mod window;

pub(crate) use model::{
    CompleteHistory, HistoryCoverage, HistoryError, HistoryScope, HistoryTotals, ListCostCoverage,
    MeteredCoverage, ModelUsageBucket, RawNumber, ScriptedEvent, ScriptedHistory, ScriptedPage,
    ScriptedTokenUsage,
};

pub(crate) use credential::{
    CredentialCandidate, CredentialLease, CredentialLeasePort, CredentialRequest, SecretCookie,
};
#[cfg(test)]
pub(crate) use fetcher::fetch_complete_history;
pub(crate) use fetcher::{FetchRequest, fetch_complete_history_with_lease};
pub(crate) use scheduler::{HistoryJobKey, HistoryScheduler, ScheduledJob};
pub(crate) use service::{HistoryDemand, HistoryService};
pub(crate) use store::HistoryStore;
#[cfg(test)]
pub(crate) use transport::AuthIdentity;
pub(crate) use transport::{
    AuthOutcome, FixedCursorTransport, HistoryTransport, PageRequest, TransportError,
};
pub(crate) use window::{BillingCycle, current_period_window};

pub(crate) fn aggregate_scripted_history(
    script: ScriptedHistory,
) -> Result<CompleteHistory, HistoryError> {
    let ScriptedHistory {
        account_id,
        from_ms,
        to_ms,
        fetched_at_ms,
        time_zone,
        utc_offset_seconds,
        requested_page_size,
        pages,
    } = script;
    let events = pagination::collect_complete_events(pages, requested_page_size)?;
    let (buckets, totals) =
        aggregate::aggregate_events(events, from_ms, to_ms, utc_offset_seconds)?;

    Ok(CompleteHistory {
        account_id,
        buckets,
        coverage: HistoryCoverage {
            from_ms,
            to_ms,
            fetched_at_ms,
            time_zone,
            complete: true,
            scope: HistoryScope::SessionVisible,
        },
        totals,
    })
}

#[cfg(test)]
mod aggregate_tests;
#[cfg(test)]
mod fetcher_tests;
#[cfg(test)]
mod scheduler_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod store_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transport_tests;
#[cfg(test)]
mod window_tests;
