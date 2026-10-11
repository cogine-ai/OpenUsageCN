use super::limits::ProviderLimitCatalog;
use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

mod account_projection;
pub(crate) use account_projection::replace_account_projection;
#[cfg(test)]
#[path = "cache_account_projection_tests.rs"]
mod account_projection_tests;
#[cfg(test)]
use account_projection::save_cache;
mod flush;
use flush::{CacheFlushResult, flush_pending_cache_once, schedule_cache_flush_locked};
#[cfg(test)]
use flush::{cache_write_retry_delay, should_log_cache_write_failure};

const CACHE_FILE_NAME: &str = "usage-api-cache.json";
const CACHE_LOCK_FILE_NAME: &str = ".usage-api-cache.lock";
pub(super) const SETTINGS_FILE_NAME: &str = "settings.json";
pub(super) const DEFAULT_ENABLED_PLUGINS: &[&str] = &["claude", "codex", "cursor"];

pub(super) use super::cache_settings::enabled_plugin_ids_ordered;

#[cfg(not(test))]
const CACHE_WRITE_DEBOUNCE: Duration = Duration::from_millis(500);
#[cfg(test)]
const CACHE_WRITE_DEBOUNCE: Duration = Duration::from_millis(10);
const CACHE_WRITE_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPluginSnapshot {
    pub provider_id: String,
    pub display_name: String,
    pub plan: Option<String>,
    pub lines: Vec<MetricLine>,
    /// When the probe that produced this snapshot started. Empty for legacy rows.
    #[serde(default)]
    pub started_at: String,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageApiCacheFile {
    version: u32,
    snapshots: HashMap<String, CachedPluginSnapshot>,
}

pub(super) struct CacheState {
    pub snapshots: HashMap<String, CachedPluginSnapshot>,
    pub app_data_dir: PathBuf,
    pub settings_data_dir: PathBuf,
    pub known_plugin_ids: Vec<String>,
    pub limit_catalog: HashMap<String, ProviderLimitCatalog>,
    pub errors: HashMap<String, String>,
    pub app_version: String,
    forced_projections: HashMap<String, Option<CachedPluginSnapshot>>,
    dirty_generation: u64,
    flushed_generation: u64,
    flush_scheduled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HealthProvidersSummary {
    pub(super) known: usize,
    pub(super) enabled: usize,
    pub(super) cached: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HealthCacheSummary {
    pub(super) ready: bool,
    pub(super) last_successful_fetch_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HealthCacheState {
    pub(super) version: String,
    pub(super) providers: HealthProvidersSummary,
    pub(super) cache: HealthCacheSummary,
}

// ---------------------------------------------------------------------------
// Global cache state (same pattern as managed_shortcut_slot in lib.rs)
// ---------------------------------------------------------------------------

pub(super) fn cache_state() -> &'static Mutex<CacheState> {
    static STATE: OnceLock<Mutex<CacheState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(CacheState {
            snapshots: HashMap::new(),
            app_data_dir: PathBuf::new(),
            settings_data_dir: PathBuf::new(),
            known_plugin_ids: Vec::new(),
            limit_catalog: HashMap::new(),
            errors: HashMap::new(),
            app_version: String::new(),
            forced_projections: HashMap::new(),
            dirty_generation: 0,
            flushed_generation: 0,
            flush_scheduled: false,
        })
    })
}

fn cache_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Cache persistence
// ---------------------------------------------------------------------------

pub fn load_cache(app_data_dir: &Path) -> HashMap<String, CachedPluginSnapshot> {
    let path = app_data_dir.join(CACHE_FILE_NAME);
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<UsageApiCacheFile>(&data) {
        Ok(file) if file.version == 1 => file.snapshots,
        Ok(_) => {
            log::warn!("usage-api-cache.json has unsupported version, starting empty");
            HashMap::new()
        }
        Err(e) => {
            log::warn!(
                "failed to parse usage-api-cache.json: {}, starting empty",
                e
            );
            HashMap::new()
        }
    }
}

#[cfg(unix)]
fn lock_cache_file(file: &std::fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "failed to lock usage cache: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(unix)]
fn unlock_cache_file(file: &std::fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "failed to unlock usage cache: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
fn lock_cache_file(_file: &std::fs::File) -> Result<(), String> {
    Ok(())
}

#[cfg(not(unix))]
fn unlock_cache_file(_file: &std::fs::File) -> Result<(), String> {
    Ok(())
}

fn parse_rfc3339(value: &str) -> Result<time::OffsetDateTime, time::error::Parse> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
}

fn snapshot_ordering_timestamp(
    snapshot: &CachedPluginSnapshot,
) -> Result<time::OffsetDateTime, time::error::Parse> {
    let started_at = snapshot.started_at.trim();
    if !started_at.is_empty() {
        return parse_rfc3339(started_at);
    }
    parse_rfc3339(snapshot.fetched_at.trim())
}

fn snapshot_is_at_least_as_new(
    incoming: &CachedPluginSnapshot,
    current: &CachedPluginSnapshot,
) -> bool {
    let now = time::OffsetDateTime::now_utc();
    let latest_credible_timestamp = now + time::Duration::minutes(5);
    match (
        snapshot_ordering_timestamp(incoming),
        snapshot_ordering_timestamp(current),
    ) {
        (Ok(incoming_at), _) if incoming_at > latest_credible_timestamp => {
            log::warn!(
                "incoming usage cache timestamp is unexpectedly in the future (provider={})",
                incoming.provider_id
            );
            false
        }
        (Ok(_), Ok(current_at)) if current_at > latest_credible_timestamp => {
            log::warn!(
                "stored usage cache timestamp is unexpectedly in the future (provider={})",
                current.provider_id
            );
            true
        }
        (Ok(incoming_at), Ok(current_at)) if incoming_at != current_at => incoming_at >= current_at,
        (Ok(_), Ok(_)) => match (
            parse_rfc3339(incoming.fetched_at.trim()),
            parse_rfc3339(current.fetched_at.trim()),
        ) {
            (Ok(incoming_at), Ok(current_at)) => incoming_at >= current_at,
            (Ok(_), Err(_)) => true,
            (Err(error), _) => {
                log::warn!(
                    "incoming usage cache fetched_at is invalid (provider={}): {}",
                    incoming.provider_id,
                    error
                );
                false
            }
        },
        (Err(error), _) => {
            log::warn!(
                "incoming usage cache timestamp is invalid (provider={}): {}",
                incoming.provider_id,
                error
            );
            false
        }
        (_, Err(error)) => {
            log::warn!(
                "stored usage cache timestamp is invalid (provider={}): {}",
                current.provider_id,
                error
            );
            true
        }
    }
}

fn adopt_disk_snapshot_if_newer(state: &mut CacheState, provider_id: &str) {
    if state.app_data_dir.as_os_str().is_empty() {
        return;
    }
    let Some(disk_snapshot) = load_cache(&state.app_data_dir).remove(provider_id) else {
        return;
    };
    let should_adopt = state
        .snapshots
        .get(provider_id)
        .map(|current| snapshot_is_at_least_as_new(&disk_snapshot, current))
        .unwrap_or(true);
    if should_adopt {
        state
            .snapshots
            .insert(provider_id.to_string(), disk_snapshot);
    }
}

// ---------------------------------------------------------------------------
// Public API: initialise + update cache
// ---------------------------------------------------------------------------

#[cfg(test)]
fn init(app_data_dir: &Path, known_plugin_ids: Vec<String>, app_version: String) {
    init_with_catalog(
        app_data_dir,
        app_data_dir,
        known_plugin_ids,
        Vec::new(),
        app_version,
    );
}

pub fn init_with_catalog(
    app_data_dir: &Path,
    settings_data_dir: &Path,
    known_plugin_ids: Vec<String>,
    catalog: Vec<ProviderLimitCatalog>,
    app_version: String,
) {
    let snapshots = load_cache(app_data_dir);
    let mut state = cache_state().lock().expect("cache state poisoned");
    state.snapshots = snapshots;
    state.app_data_dir = app_data_dir.to_path_buf();
    state.settings_data_dir = settings_data_dir.to_path_buf();
    state.known_plugin_ids = known_plugin_ids;
    state.limit_catalog = catalog
        .into_iter()
        .map(|provider| (provider.provider_id.clone(), provider))
        .collect();
    state.errors.clear();
    state.app_version = app_version;
    state.forced_projections.clear();
    state.dirty_generation = 0;
    state.flushed_generation = 0;
    state.flush_scheduled = false;
}

fn snapshot_from_output(
    output: &PluginOutput,
    started_at: time::OffsetDateTime,
) -> CachedPluginSnapshot {
    let format_timestamp = |value: time::OffsetDateTime| {
        value
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default()
    };
    CachedPluginSnapshot {
        provider_id: output.provider_id.clone(),
        display_name: output.display_name.clone(),
        plan: output.plan.clone(),
        lines: output.lines.clone(),
        started_at: format_timestamp(started_at),
        fetched_at: format_timestamp(time::OffsetDateTime::now_utc()),
    }
}

pub fn cache_successful_output(output: &PluginOutput, started_at: time::OffsetDateTime) {
    let snapshot = snapshot_from_output(output, started_at);

    let _write_guard = cache_write_lock()
        .lock()
        .expect("cache write lock poisoned");
    let mut state = cache_state().lock().expect("cache state poisoned");
    adopt_disk_snapshot_if_newer(&mut state, &output.provider_id);
    if state
        .snapshots
        .get(&output.provider_id)
        .is_some_and(|current| !snapshot_is_at_least_as_new(&snapshot, current))
    {
        log::debug!(
            "usage cache ignored older probe result for {}",
            output.provider_id
        );
        return;
    }
    state.snapshots.insert(output.provider_id.clone(), snapshot);
    state.errors.remove(&output.provider_id);
    state.dirty_generation = state.dirty_generation.wrapping_add(1);
    schedule_cache_flush_locked(&mut state);
}

pub fn record_probe_error(provider_id: &str, message: impl Into<String>) {
    let mut state = cache_state().lock().expect("cache state poisoned");
    state.errors.insert(provider_id.to_string(), message.into());
}

pub fn flush_cache() -> Result<(), String> {
    match flush_pending_cache_once() {
        CacheFlushResult::Idle | CacheFlushResult::Flushed => Ok(()),
        CacheFlushResult::Failed(error) => {
            log::error!("{error}");
            Err(error)
        }
    }
}

pub(crate) fn enabled_provider_ids() -> Vec<String> {
    let state = cache_state().lock().expect("cache state poisoned");
    enabled_plugin_ids_ordered(&state)
}

pub(crate) fn snapshot_for_provider(provider_id: &str) -> Option<CachedPluginSnapshot> {
    cache_state()
        .lock()
        .expect("cache state poisoned")
        .snapshots
        .get(provider_id)
        .cloned()
}

/// Build the ordered list of enabled cached snapshots for GET /v1/usage.
pub(super) fn enabled_snapshots_ordered(state: &CacheState) -> Vec<CachedPluginSnapshot> {
    enabled_plugin_ids_ordered(state)
        .into_iter()
        .filter_map(|id| state.snapshots.get(&id).cloned())
        .collect()
}

pub(super) fn health_cache_state() -> HealthCacheState {
    let state = cache_state().lock().expect("cache state poisoned");
    let enabled_plugin_ids = enabled_plugin_ids_ordered(&state);
    let enabled_cached_snapshots: Vec<&CachedPluginSnapshot> = enabled_plugin_ids
        .iter()
        .filter_map(|id| state.snapshots.get(id))
        .collect();
    let last_successful_fetch_at = enabled_cached_snapshots
        .iter()
        .filter_map(|snapshot| {
            let fetched_at = snapshot.fetched_at.trim();
            if fetched_at.is_empty() {
                None
            } else {
                Some(fetched_at.to_string())
            }
        })
        .max();

    HealthCacheState {
        version: state.app_version.clone(),
        providers: HealthProvidersSummary {
            known: state.known_plugin_ids.len(),
            enabled: enabled_plugin_ids.len(),
            cached: enabled_cached_snapshots.len(),
        },
        cache: HealthCacheSummary {
            ready: last_successful_fetch_at.is_some(),
            last_successful_fetch_at,
        },
    }
}

#[cfg(test)]
pub(super) fn empty_cache_state_for_tests() -> CacheState {
    CacheState {
        snapshots: HashMap::new(),
        app_data_dir: PathBuf::from("."),
        settings_data_dir: PathBuf::from("."),
        known_plugin_ids: Vec::new(),
        limit_catalog: HashMap::new(),
        errors: HashMap::new(),
        app_version: "0.0.0".to_string(),
        dirty_generation: 0,
        flushed_generation: 0,
        flush_scheduled: false,
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
