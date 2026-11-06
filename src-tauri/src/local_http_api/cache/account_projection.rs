use super::{CachedPluginSnapshot, UsageApiCacheFile};
use crate::plugin_engine::runtime::PluginOutput;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::Path;
use std::time::{Duration, Instant};

#[cfg(test)]
pub(super) fn save_cache(
    app_data_dir: &Path,
    snapshots: &HashMap<String, CachedPluginSnapshot>,
) -> Result<(), String> {
    save_cache_with_forced_providers(app_data_dir, snapshots, &HashMap::new())
}

pub(super) fn save_cache_with_forced_providers(
    app_data_dir: &Path,
    snapshots: &HashMap<String, CachedPluginSnapshot>,
    forced_projections: &HashMap<String, Option<CachedPluginSnapshot>>,
) -> Result<(), String> {
    save_cache_before(app_data_dir, snapshots, forced_projections, None)
}

fn save_cache_before(
    app_data_dir: &Path,
    snapshots: &HashMap<String, CachedPluginSnapshot>,
    forced_projections: &HashMap<String, Option<CachedPluginSnapshot>>,
    deadline: Option<Instant>,
) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("failed to create app data directory: {e}"))?;
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(app_data_dir.join(super::CACHE_LOCK_FILE_NAME))
        .map_err(|e| format!("failed to open usage cache lock: {e}"))?;
    if let Some(deadline) = deadline {
        loop {
            match lock_file.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => {
                    log::error!("Ollama usage cache file lock timed out or failed");
                    return Err("用量缓存正在被其他进程使用，请稍后重试。".into());
                }
            }
        }
    } else {
        super::lock_cache_file(&lock_file)?;
    }

    let mut merged_snapshots = super::load_cache(app_data_dir);
    for (incoming_id, incoming) in snapshots {
        if forced_projections.contains_key(incoming_id) || !super::snapshot_is_current(incoming) {
            continue;
        }
        let should_replace = merged_snapshots
            .get(incoming_id)
            .map(|current| super::snapshot_is_at_least_as_new(incoming, current))
            .unwrap_or(true);
        if should_replace {
            merged_snapshots.insert(incoming_id.clone(), incoming.clone());
        }
    }
    for (provider_id, projection) in forced_projections {
        match projection {
            Some(snapshot) => {
                if super::snapshot_is_current(snapshot) {
                    merged_snapshots.insert(provider_id.clone(), snapshot.clone());
                }
            }
            None => {
                merged_snapshots.remove(provider_id);
            }
        }
    }
    let json = serde_json::to_string(&UsageApiCacheFile {
        version: 1,
        snapshots: merged_snapshots,
    })
    .map_err(|e| format!("failed to serialize usage cache: {e}"))?;
    let write_result =
        crate::safe_file::write_text(&app_data_dir.join(super::CACHE_FILE_NAME), &json)
            .map_err(|e| format!("failed to save usage cache: {e}"));
    let unlock_result = super::unlock_cache_file(&lock_file);
    write_result?;
    unlock_result
}

pub(crate) fn replace_account_projection(
    provider_id: &str,
    projection: Option<(&PluginOutput, time::OffsetDateTime)>,
) -> Result<(), String> {
    let projection =
        projection.map(|(output, started_at)| super::snapshot_from_output(output, started_at));
    replace_cached_account_projection(provider_id, projection)
}

/// Restores a selected account's stored result without making its fetch time look current.
pub(crate) fn replace_cached_account_projection(
    provider_id: &str,
    projection: Option<CachedPluginSnapshot>,
) -> Result<(), String> {
    replace_projection_before(provider_id, projection, None)
}

pub(crate) fn replace_cached_account_projection_before(
    provider_id: &str,
    projection: Option<CachedPluginSnapshot>,
    deadline: Instant,
) -> Result<(), String> {
    replace_projection_before(provider_id, projection, Some(deadline))
}

fn replace_projection_before(
    provider_id: &str,
    projection: Option<CachedPluginSnapshot>,
    deadline: Option<Instant>,
) -> Result<(), String> {
    if projection
        .as_ref()
        .is_some_and(|snapshot| snapshot.provider_id != provider_id)
    {
        return Err("account projection provider does not match".to_string());
    }
    if projection
        .as_ref()
        .is_some_and(|snapshot| !super::snapshot_is_current(snapshot))
    {
        return Err("连接来源已更改，请重新刷新。".into());
    }
    let configured_deletion =
        projection.is_none() && crate::configured_providers::supports(provider_id);
    let mutex = super::cache_write_lock();
    let _write_guard = if let Some(deadline) = deadline {
        loop {
            match mutex.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => {
                    log::error!("Ollama usage cache write lock timed out or failed");
                    return Err("用量缓存正在被其他操作使用，请稍后重试。".into());
                }
            }
        }
    } else {
        mutex.lock().expect("cache write lock poisoned")
    };
    let (generation, app_data_dir, snapshots, forced_projections) = {
        let mut state = super::cache_state().lock().expect("cache state poisoned");
        match &projection {
            Some(snapshot) => {
                state
                    .snapshots
                    .insert(provider_id.to_string(), snapshot.clone());
            }
            None => {
                state.snapshots.remove(provider_id);
            }
        }
        state.errors.remove(provider_id);
        state
            .forced_projections
            .insert(provider_id.to_string(), projection);
        state.dirty_generation = state.dirty_generation.wrapping_add(1);
        (
            state.dirty_generation,
            state.app_data_dir.clone(),
            state.snapshots.clone(),
            state.forced_projections.clone(),
        )
    };
    let result = save_cache_before(&app_data_dir, &snapshots, &forced_projections, deadline);
    if result.is_ok() {
        super::flush::mark_cache_flushed(generation);
    } else {
        let mut state = super::cache_state().lock().expect("cache state poisoned");
        if configured_deletion {
            // The failed configuration mutation is aborted. A later account's cache must
            // not be deleted by retrying this unscoped tombstone from another process.
            state.forced_projections.remove(provider_id);
        }
        super::flush::schedule_cache_flush_locked(&mut state);
    }
    result
}
