use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, mpsc};

use std::time::{Duration, Instant};

use super::{HistoryError, TransportError};

pub(super) const REFRESH_BUDGET: Duration = Duration::from_secs(60);

pub(super) fn remaining_budget(deadline: Instant) -> Result<Duration, HistoryError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(HistoryError::Transport(TransportError::Timeout))
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct HistoryJobKey {
    pub provider_id: String,
    pub account_id: String,
    pub from_ms: i64,
    pub to_ms: i64,
    pub time_zone: String,
    pub credential_generation: String,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct HistoryJobScope {
    provider_id: String,
    account_id: String,
    time_zone: String,
    credential_generation: String,
}

impl From<&HistoryJobKey> for HistoryJobScope {
    fn from(key: &HistoryJobKey) -> Self {
        Self {
            provider_id: key.provider_id.clone(),
            account_id: key.account_id.clone(),
            time_zone: key.time_zone.clone(),
            credential_generation: key.credential_generation.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct CancellationToken {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl CancellationToken {
    fn new(deadline: Instant) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline,
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(super) fn deadline(&self) -> Instant {
        self.deadline
    }

    pub(super) fn check(&self) -> Result<(), HistoryError> {
        if self.is_cancelled() {
            return Err(HistoryError::Cancelled);
        }
        remaining_budget(self.deadline).map(|_| ())
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }
}

pub(crate) struct ScheduledJob<T> {
    receiver: mpsc::Receiver<Result<T, HistoryError>>,
}

impl<T> ScheduledJob<T> {
    pub(crate) fn wait(self) -> Result<T, HistoryError> {
        self.receiver
            .recv()
            .map_err(|_| HistoryError::SchedulerClosed)?
    }
}

#[derive(Default)]
struct SchedulerState {
    active: usize,
    latest: HashMap<HistoryJobScope, CancellationToken>,
    running: HashMap<HistoryJobScope, CancellationToken>,
}

#[derive(Default)]
struct SchedulerInner {
    state: Mutex<SchedulerState>,
    changed: Condvar,
}

#[derive(Clone)]
pub(crate) struct HistoryScheduler {
    inner: Arc<SchedulerInner>,
}

impl Default for HistoryScheduler {
    fn default() -> Self {
        Self::global()
    }
}

impl HistoryScheduler {
    pub(crate) fn global() -> Self {
        static INNER: OnceLock<Arc<SchedulerInner>> = OnceLock::new();
        Self {
            inner: Arc::clone(INNER.get_or_init(|| Arc::new(SchedulerInner::default()))),
        }
    }

    #[cfg(test)]
    pub(super) fn isolated_for_test() -> Self {
        Self {
            inner: Arc::new(SchedulerInner::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn schedule<T, F>(
        &self,
        key: HistoryJobKey,
        work: F,
    ) -> Result<ScheduledJob<T>, HistoryError>
    where
        T: Send + 'static,
        F: FnOnce(CancellationToken) -> Result<T, HistoryError> + Send + 'static,
    {
        self.schedule_with_deadline(key, Instant::now() + REFRESH_BUDGET, work)
    }

    pub(super) fn schedule_with_deadline<T, F>(
        &self,
        key: HistoryJobKey,
        deadline: Instant,
        work: F,
    ) -> Result<ScheduledJob<T>, HistoryError>
    where
        T: Send + 'static,
        F: FnOnce(CancellationToken) -> Result<T, HistoryError> + Send + 'static,
    {
        let token = CancellationToken::new(deadline);
        let scope = HistoryJobScope::from(&key);
        {
            let mut state = self.inner.state.lock().unwrap();
            if let Some(previous) = state.latest.insert(scope.clone(), token.clone()) {
                previous.cancel();
            }
            self.inner.changed.notify_all();
        }

        let (sender, receiver) = mpsc::channel();
        let inner = Arc::clone(&self.inner);
        let worker_scope = scope.clone();
        let worker_token = token.clone();
        let spawned = std::thread::Builder::new()
            .name("cursor-history-job".to_string())
            .spawn(move || {
                let mut state = inner.state.lock().unwrap();
                loop {
                    if let Err(error) = worker_token.check() {
                        if state
                            .latest
                            .get(&worker_scope)
                            .is_some_and(|latest| latest.same_as(&worker_token))
                        {
                            state.latest.remove(&worker_scope);
                        }
                        inner.changed.notify_all();
                        drop(state);
                        let _ = sender.send(Err(error));
                        return;
                    }
                    if state.active < 2 && !state.running.contains_key(&worker_scope) {
                        state.active += 1;
                        state
                            .running
                            .insert(worker_scope.clone(), worker_token.clone());
                        break;
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    state = inner.changed.wait_timeout(state, remaining).unwrap().0;
                }
                drop(state);

                let mut result = work(worker_token.clone());
                if let Err(error) = worker_token.check() {
                    result = Err(error);
                }

                let mut state = inner.state.lock().unwrap();
                state.active = state.active.saturating_sub(1);
                if state
                    .running
                    .get(&worker_scope)
                    .is_some_and(|running| running.same_as(&worker_token))
                {
                    state.running.remove(&worker_scope);
                }
                if state
                    .latest
                    .get(&worker_scope)
                    .is_some_and(|latest| latest.same_as(&worker_token))
                {
                    state.latest.remove(&worker_scope);
                }
                inner.changed.notify_all();
                drop(state);
                let _ = sender.send(result);
            });

        if spawned.is_err() {
            token.cancel();
            let mut state = self.inner.state.lock().unwrap();
            if state
                .latest
                .get(&scope)
                .is_some_and(|latest| latest.same_as(&token))
            {
                state.latest.remove(&scope);
            }
            self.inner.changed.notify_all();
            return Err(HistoryError::SchedulerUnavailable);
        }
        Ok(ScheduledJob { receiver })
    }
}
