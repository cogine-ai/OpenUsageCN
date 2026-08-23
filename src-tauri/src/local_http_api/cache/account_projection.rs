use super::{CachedPluginSnapshot, UsageApiCacheFile};
use crate::plugin_engine::runtime::PluginOutput;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::Path;

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
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("failed to create app data directory: {e}"))?;
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(app_data_dir.join(super::CACHE_LOCK_FILE_NAME))
        .map_err(|e| format!("failed to open usage cache lock: {e}"))?;
    super::lock_cache_file(&lock_file)?;

    let mut merged_snapshots = super::load_cache(app_data_dir);
    for (incoming_id, incoming) in snapshots {
        if forced_projections.contains_key(incoming_id) {
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
                merged_snapshots.insert(provider_id.clone(), snapshot.clone());
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
    if projection
        .as_ref()
        .is_some_and(|snapshot| snapshot.provider_id != provider_id)
    {
        return Err("account projection provider does not match".to_string());
    }
    let _write_guard = super::cache_write_lock()
        .lock()
        .expect("cache write lock poisoned");
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
    let result = save_cache_with_forced_providers(&app_data_dir, &snapshots, &forced_projections);
    if result.is_ok() {
        super::flush::mark_cache_flushed(generation);
    } else {
        let mut state = super::cache_state().lock().expect("cache state poisoned");
        super::flush::schedule_cache_flush_locked(&mut state);
    }
    result
}
