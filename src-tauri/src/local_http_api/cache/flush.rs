use super::CachedPluginSnapshot;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CacheFlushResult {
    Idle,
    Flushed,
    Failed(String),
}

pub(super) fn schedule_cache_flush_locked(state: &mut super::CacheState) {
    if state.flush_scheduled {
        return;
    }
    state.flush_scheduled = true;
    std::thread::spawn(debounced_cache_flush_worker);
}

fn debounced_cache_flush_worker() {
    let mut consecutive_failures = 0_u32;
    let mut retry_delay = super::CACHE_WRITE_DEBOUNCE;
    loop {
        std::thread::sleep(retry_delay);
        match flush_pending_cache_once() {
            CacheFlushResult::Idle => return,
            CacheFlushResult::Flushed => {
                if consecutive_failures > 0 {
                    log::info!(
                        "usage-api-cache.json write recovered after {} failed attempts",
                        consecutive_failures
                    );
                }
                consecutive_failures = 0;
                retry_delay = super::CACHE_WRITE_DEBOUNCE;
            }
            CacheFlushResult::Failed(error) => {
                consecutive_failures = consecutive_failures.saturating_add(1);
                retry_delay = cache_write_retry_delay(consecutive_failures);
                if should_log_cache_write_failure(consecutive_failures) {
                    log::warn!(
                        "{}; retrying in {:?} (consecutive failures: {})",
                        error,
                        retry_delay,
                        consecutive_failures
                    );
                }
            }
        }
    }
}

pub(super) fn cache_write_retry_delay(consecutive_failures: u32) -> Duration {
    let factor = 1_u32 << consecutive_failures.min(16);
    std::cmp::min(
        super::CACHE_WRITE_DEBOUNCE.saturating_mul(factor),
        super::CACHE_WRITE_RETRY_MAX_DELAY,
    )
}

pub(super) fn should_log_cache_write_failure(consecutive_failures: u32) -> bool {
    consecutive_failures == 1 || consecutive_failures.is_power_of_two()
}

fn pending_cache_write() -> Option<(
    u64,
    PathBuf,
    HashMap<String, CachedPluginSnapshot>,
    HashMap<String, Option<CachedPluginSnapshot>>,
)> {
    let mut state = super::cache_state().lock().expect("cache state poisoned");
    if state.dirty_generation == state.flushed_generation {
        state.flush_scheduled = false;
        return None;
    }
    Some((
        state.dirty_generation,
        state.app_data_dir.clone(),
        state.snapshots.clone(),
        state.forced_projections.clone(),
    ))
}

pub(super) fn mark_cache_flushed(generation: u64) {
    let mut state = super::cache_state().lock().expect("cache state poisoned");
    state.flushed_generation = generation;
    if state.dirty_generation == generation {
        state.forced_projections.clear();
    }
}

pub(super) fn flush_pending_cache_once() -> CacheFlushResult {
    let _write_guard = super::cache_write_lock()
        .lock()
        .expect("cache write lock poisoned");
    let Some((generation, app_data_dir, snapshots, forced_projections)) = pending_cache_write()
    else {
        return CacheFlushResult::Idle;
    };
    match super::account_projection::save_cache_with_forced_providers(
        &app_data_dir,
        &snapshots,
        &forced_projections,
    ) {
        Ok(()) => {
            mark_cache_flushed(generation);
            CacheFlushResult::Flushed
        }
        Err(error) => CacheFlushResult::Failed(error),
    }
}
