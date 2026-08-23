use std::sync::Arc;

use super::{
    BillingCycle, CompleteHistory, CredentialLeasePort, CredentialRequest, FetchRequest,
    HistoryError, HistoryJobKey, HistoryScheduler, HistoryStore, HistoryTransport, ScheduledJob,
    current_period_window, fetch_complete_history_with_lease,
};

pub(crate) struct HistoryDemand {
    pub provider_id: String,
    pub account_id: String,
    pub now_ms: i64,
    pub billing_cycle: Option<BillingCycle>,
    pub time_zone: String,
    pub utc_offset_seconds: i32,
}

pub(crate) struct HistoryRefresh {
    pub snapshot: Option<CompleteHistory>,
    pub stale: bool,
    pub error: Option<HistoryError>,
}

enum RefreshSource {
    Ready(HistoryRefresh),
    Scheduled {
        job: ScheduledJob<HistoryRefresh>,
        previous: Option<CompleteHistory>,
    },
}

pub(crate) struct HistoryRefreshHandle {
    source: RefreshSource,
}

impl HistoryRefreshHandle {
    pub(crate) fn wait(self) -> Result<HistoryRefresh, HistoryError> {
        match self.source {
            RefreshSource::Ready(refresh) => Ok(refresh),
            RefreshSource::Scheduled { job, previous } => match job.wait() {
                Ok(refresh) => Ok(refresh),
                Err(error) => Ok(failed_refresh(previous, error)),
            },
        }
    }

    fn ready(refresh: HistoryRefresh) -> Self {
        Self {
            source: RefreshSource::Ready(refresh),
        }
    }
}

pub(crate) struct HistoryService {
    credentials: Arc<dyn CredentialLeasePort>,
    transport: Arc<dyn HistoryTransport>,
    store: HistoryStore,
    scheduler: HistoryScheduler,
}

impl HistoryService {
    pub(crate) fn new(
        credentials: Arc<dyn CredentialLeasePort>,
        transport: Arc<dyn HistoryTransport>,
        store: HistoryStore,
        scheduler: HistoryScheduler,
    ) -> Self {
        Self {
            credentials,
            transport,
            store,
            scheduler,
        }
    }

    #[cfg(test)]
    pub(crate) fn cached(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<Option<CompleteHistory>, HistoryError> {
        self.store.load(provider_id, account_id)
    }

    pub(crate) fn refresh(
        &self,
        demand: HistoryDemand,
    ) -> Result<HistoryRefreshHandle, HistoryError> {
        if demand.provider_id != "cursor" {
            return Err(HistoryError::UnsupportedProvider);
        }
        let window = current_period_window(
            demand.now_ms,
            demand.billing_cycle,
            demand.time_zone,
            demand.utc_offset_seconds,
        )?;
        let previous = self.store.load(&demand.provider_id, &demand.account_id)?;
        let lease = match self.credentials.acquire(CredentialRequest {
            provider_id: &demand.provider_id,
            account_id: &demand.account_id,
        }) {
            Ok(lease) => lease,
            Err(error) => {
                return Ok(HistoryRefreshHandle::ready(failed_refresh(previous, error)));
            }
        };
        if lease.provider_id() != demand.provider_id || lease.account_id() != demand.account_id {
            return Ok(HistoryRefreshHandle::ready(failed_refresh(
                previous,
                HistoryError::CredentialLeaseMismatch,
            )));
        }

        let key = HistoryJobKey {
            provider_id: demand.provider_id.clone(),
            account_id: demand.account_id.clone(),
            from_ms: window.from_ms,
            to_ms: window.to_ms,
            time_zone: window.time_zone.clone(),
            credential_generation: lease.generation().to_string(),
        };
        let request = FetchRequest {
            provider_id: demand.provider_id,
            account_id: demand.account_id,
            from_ms: window.from_ms,
            to_ms: window.to_ms,
            fetched_at_ms: demand.now_ms,
            time_zone: window.time_zone,
            utc_offset_seconds: window.utc_offset_seconds,
        };
        let credentials = Arc::clone(&self.credentials);
        let transport = Arc::clone(&self.transport);
        let store = self.store.clone();
        let prior_for_job = previous.clone();
        let key_for_job = key.clone();
        let scheduled = self.scheduler.schedule(key, move |cancel| {
            let fetched = fetch_complete_history_with_lease(
                credentials.as_ref(),
                transport.as_ref(),
                &lease,
                request,
                &|| cancel.is_cancelled(),
            );
            let history = match fetched {
                Ok(history) => history,
                Err(error) => return Ok(failed_refresh(prior_for_job, error)),
            };
            if history.account_id != key_for_job.account_id
                || history.coverage.from_ms != key_for_job.from_ms
                || history.coverage.to_ms != key_for_job.to_ms
                || history.coverage.time_zone != key_for_job.time_zone
                || !history.coverage.complete
            {
                return Ok(failed_refresh(
                    prior_for_job,
                    HistoryError::ResultScopeChanged,
                ));
            }

            let mut commit = || {
                if cancel.is_cancelled() {
                    return Err(HistoryError::Cancelled);
                }
                store.save(&key_for_job.provider_id, &key_for_job.account_id, &history)
            };
            match credentials.with_current_lease(&lease, &mut commit) {
                Ok(()) => Ok(HistoryRefresh {
                    snapshot: Some(history),
                    stale: false,
                    error: None,
                }),
                Err(error) => Ok(failed_refresh(prior_for_job, error)),
            }
        });

        match scheduled {
            Ok(job) => Ok(HistoryRefreshHandle {
                source: RefreshSource::Scheduled { job, previous },
            }),
            Err(error) => Ok(HistoryRefreshHandle::ready(failed_refresh(previous, error))),
        }
    }
}

fn failed_refresh(previous: Option<CompleteHistory>, error: HistoryError) -> HistoryRefresh {
    HistoryRefresh {
        stale: previous.is_some(),
        snapshot: previous,
        error: Some(error),
    }
}
