use super::*;
use crate::plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
use serial_test::serial;
use std::time::Instant;

fn make_snapshot(id: &str, name: &str) -> CachedPluginSnapshot {
    CachedPluginSnapshot {
        provider_id: id.to_string(),
        display_name: name.to_string(),
        plan: Some("Pro".to_string()),
        lines: vec![],
        started_at: "2026-03-26T08:15:30Z".to_string(),
        fetched_at: "2026-03-26T08:15:30Z".to_string(),
    }
}

fn make_output(id: &str, name: &str) -> PluginOutput {
    PluginOutput {
        provider_id: id.to_string(),
        display_name: name.to_string(),
        plan: Some("Pro".to_string()),
        lines: vec![MetricLine::Text {
            label: "Usage".to_string(),
            value: "42%".to_string(),
            color: None,
            subtitle: None,
        }],
        icon_url: String::new(),
    }
}

fn temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "openusagecn-test-{}-{}",
        label,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn wait_for_cached_snapshots(
    dir: &Path,
    expected_len: usize,
) -> HashMap<String, CachedPluginSnapshot> {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let loaded = load_cache(dir);
        if loaded.len() == expected_len {
            return loaded;
        }
        assert!(
            Instant::now() < deadline,
            "cache file was not flushed within the test deadline"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_cache_writer_idle() {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let state = cache_state().lock().unwrap();
        if !state.flush_scheduled && state.dirty_generation == state.flushed_generation {
            return;
        }
        drop(state);
        assert!(
            Instant::now() < deadline,
            "debounced cache writer did not return to idle"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn cache_write_retry_delay_backs_off_and_caps() {
    assert_eq!(
        cache_write_retry_delay(1),
        CACHE_WRITE_DEBOUNCE.saturating_mul(2)
    );
    assert_eq!(
        cache_write_retry_delay(2),
        CACHE_WRITE_DEBOUNCE.saturating_mul(4)
    );
    assert_eq!(cache_write_retry_delay(20), CACHE_WRITE_RETRY_MAX_DELAY);
}

#[test]
fn cache_write_failure_logs_are_throttled() {
    assert!(should_log_cache_write_failure(1));
    assert!(should_log_cache_write_failure(2));
    assert!(!should_log_cache_write_failure(3));
    assert!(should_log_cache_write_failure(4));
    assert!(!should_log_cache_write_failure(5));
    assert!(should_log_cache_write_failure(16));
}

#[test]
fn snapshot_serializes_with_fetched_at() {
    let snap = make_snapshot("claude", "Claude");
    let json: serde_json::Value = serde_json::to_value(&snap).unwrap();
    assert!(json.get("fetchedAt").is_some());
    assert!(json.get("startedAt").is_some());
    assert!(json.get("fetched_at").is_none());
    assert_eq!(json["fetchedAt"], "2026-03-26T08:15:30Z");
    assert_eq!(json["startedAt"], "2026-03-26T08:15:30Z");
}

#[test]
#[serial]
fn health_cache_state_counts_enabled_cached_snapshots_only() {
    let dir = temp_dir("health-enabled-cache");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(SETTINGS_FILE_NAME),
        r#"{"plugins":{"order":["claude","codex"],"disabled":["claude"]}}"#,
    )
    .unwrap();

    init(
        &dir,
        vec!["claude".to_string(), "codex".to_string()],
        "test-version".to_string(),
    );
    {
        let mut state = cache_state().lock().unwrap();
        state
            .snapshots
            .insert("claude".to_string(), make_snapshot("claude", "Claude"));
    }

    let health = health_cache_state();

    assert_eq!(health.providers.known, 2);
    assert_eq!(health.providers.enabled, 1);
    assert_eq!(health.providers.cached, 0);
    assert!(!health.cache.ready);
    assert_eq!(health.cache.last_successful_fetch_at, None);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cache_file_round_trip() {
    let dir = temp_dir("cache");
    std::fs::create_dir_all(&dir).unwrap();

    let mut snapshots = HashMap::new();
    snapshots.insert("claude".to_string(), make_snapshot("claude", "Claude"));

    save_cache(&dir, &snapshots).unwrap();
    let loaded = load_cache(&dir);

    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded["claude"].provider_id, "claude");
    assert_eq!(loaded["claude"].fetched_at, "2026-03-26T08:15:30Z");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cache_save_merges_providers_without_replacing_a_newer_snapshot() {
    let dir = temp_dir("cache-merge");
    std::fs::create_dir_all(&dir).unwrap();

    let mut newer_a = make_snapshot("provider-a", "Newer A");
    newer_a.fetched_at = "2026-03-26T09:15:30Z".to_string();
    save_cache(&dir, &HashMap::from([("provider-a".to_string(), newer_a)])).unwrap();

    let older_a = make_snapshot("provider-a", "Older A");
    let provider_b = make_snapshot("provider-b", "Provider B");
    save_cache(
        &dir,
        &HashMap::from([
            ("provider-a".to_string(), older_a),
            ("provider-b".to_string(), provider_b),
        ]),
    )
    .unwrap();

    let loaded = load_cache(&dir);
    assert_eq!(loaded["provider-a"].display_name, "Newer A");
    assert_eq!(loaded["provider-a"].fetched_at, "2026-03-26T09:15:30Z");
    assert_eq!(loaded["provider-b"].display_name, "Provider B");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cache_merge_rejects_an_invalid_incoming_timestamp() {
    let current = make_snapshot("provider-a", "Current");
    let mut incoming = make_snapshot("provider-a", "Invalid Incoming");
    incoming.started_at = "not-a-timestamp".to_string();
    incoming.fetched_at = "not-a-timestamp".to_string();

    assert!(!snapshot_is_at_least_as_new(&incoming, &current));
}

#[test]
fn cache_merge_does_not_let_a_future_stored_timestamp_block_current_data() {
    let mut current = make_snapshot("provider-a", "Future Stored");
    let future = (time::OffsetDateTime::now_utc() + time::Duration::hours(1))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    current.started_at = future.clone();
    current.fetched_at = future;
    let mut incoming = make_snapshot("provider-a", "Current Incoming");
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    incoming.started_at = now.clone();
    incoming.fetched_at = now;

    assert!(snapshot_is_at_least_as_new(&incoming, &current));
}

#[test]
fn cache_merge_rejects_an_incoming_timestamp_far_in_the_future() {
    let current = make_snapshot("provider-a", "Current");
    let mut incoming = make_snapshot("provider-a", "Future Incoming");
    let future = (time::OffsetDateTime::now_utc() + time::Duration::hours(1))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    incoming.started_at = future.clone();
    incoming.fetched_at = future;

    assert!(!snapshot_is_at_least_as_new(&incoming, &current));
}

#[test]
fn cache_merge_prefers_later_probe_start_over_later_completion() {
    let mut earlier_start_later_finish = make_snapshot("provider-a", "Stale Slow Probe");
    earlier_start_later_finish.started_at = "2026-03-26T08:00:00Z".to_string();
    earlier_start_later_finish.fetched_at = "2026-03-26T08:20:00Z".to_string();

    let mut later_start_earlier_finish = make_snapshot("provider-a", "Fresh Fast Probe");
    later_start_earlier_finish.started_at = "2026-03-26T08:05:00Z".to_string();
    later_start_earlier_finish.fetched_at = "2026-03-26T08:06:00Z".to_string();

    assert!(snapshot_is_at_least_as_new(
        &later_start_earlier_finish,
        &earlier_start_later_finish
    ));
    assert!(!snapshot_is_at_least_as_new(
        &earlier_start_later_finish,
        &later_start_earlier_finish
    ));
}

#[test]
fn cache_merge_falls_back_to_fetched_at_when_started_at_missing() {
    let mut legacy_current = make_snapshot("provider-a", "Legacy Current");
    legacy_current.started_at.clear();
    legacy_current.fetched_at = "2026-03-26T09:00:00Z".to_string();

    let mut legacy_older = make_snapshot("provider-a", "Legacy Older");
    legacy_older.started_at.clear();
    legacy_older.fetched_at = "2026-03-26T08:00:00Z".to_string();

    assert!(!snapshot_is_at_least_as_new(&legacy_older, &legacy_current));
    assert!(snapshot_is_at_least_as_new(&legacy_current, &legacy_older));
}

#[test]
fn load_cache_returns_empty_on_missing_file() {
    let dir = temp_dir("no-cache");
    let loaded = load_cache(&dir);
    assert!(loaded.is_empty());
}

#[test]
fn load_cache_returns_empty_on_invalid_json() {
    let dir = temp_dir("bad-cache");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(CACHE_FILE_NAME), "not json").unwrap();

    let loaded = load_cache(&dir);
    assert!(loaded.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn load_cache_returns_empty_on_unsupported_version() {
    let dir = temp_dir("unsupported-cache-version");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(CACHE_FILE_NAME), r#"{"version":2,"snapshots":{}}"#).unwrap();

    let loaded = load_cache(&dir);
    assert!(loaded.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[serial]
fn enabled_snapshots_ordered_uses_default_enabled_plugins_without_settings() {
    let dir = temp_dir("default-enabled-plugins");
    std::fs::create_dir_all(&dir).unwrap();

    init(
        &dir,
        vec![
            "claude".to_string(),
            "codex".to_string(),
            "cursor".to_string(),
            "zai".to_string(),
        ],
        "test-version".to_string(),
    );
    {
        let mut state = cache_state().lock().unwrap();
        state
            .snapshots
            .insert("codex".to_string(), make_snapshot("codex", "Codex"));
        state
            .snapshots
            .insert("zai".to_string(), make_snapshot("zai", "Z.ai"));
    }

    let snapshots = {
        let state = cache_state().lock().unwrap();
        enabled_snapshots_ordered(&state)
    };

    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].provider_id, "codex");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[serial]
fn enabled_providers_read_preferences_from_a_separate_settings_directory() {
    let cache_dir = temp_dir("local-cache");
    let settings_dir = temp_dir("roaming-settings");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::create_dir_all(&settings_dir).unwrap();
    std::fs::write(
        settings_dir.join(SETTINGS_FILE_NAME),
        r#"{"plugins":{"order":["codex","zai"],"disabled":["codex"]}}"#,
    )
    .unwrap();

    init_with_catalog(
        &cache_dir,
        &settings_dir,
        vec!["codex".to_string(), "zai".to_string()],
        Vec::new(),
        "test-version".to_string(),
    );

    assert_eq!(enabled_provider_ids(), vec!["zai"]);
    assert!(!cache_dir.join(SETTINGS_FILE_NAME).exists());

    let _ = std::fs::remove_dir_all(&cache_dir);
    let _ = std::fs::remove_dir_all(&settings_dir);
}

#[test]
#[serial]
fn cache_successful_output_ignores_older_probe_after_newer_disk_snapshot() {
    let dir = temp_dir("older-probe-ignored");
    std::fs::create_dir_all(&dir).unwrap();

    let mut newer_from_cli = make_snapshot("claude", "CLI Fresh");
    newer_from_cli.started_at = "2026-03-26T08:10:00Z".to_string();
    newer_from_cli.fetched_at = "2026-03-26T08:11:00Z".to_string();
    save_cache(
        &dir,
        &HashMap::from([("claude".to_string(), newer_from_cli.clone())]),
    )
    .unwrap();

    init(&dir, vec!["claude".to_string()], "test".to_string());
    {
        let mut older_in_memory = make_snapshot("claude", "App Stale Memory");
        older_in_memory.started_at = "2026-03-26T08:00:00Z".to_string();
        older_in_memory.fetched_at = "2026-03-26T08:01:00Z".to_string();
        let mut state = cache_state().lock().unwrap();
        state
            .snapshots
            .insert("claude".to_string(), older_in_memory);
    }

    let late_app_finish = time::OffsetDateTime::parse(
        "2026-03-26T08:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    cache_successful_output(&make_output("claude", "App Stale Slow"), late_app_finish);

    {
        let state = cache_state().lock().unwrap();
        assert_eq!(state.snapshots["claude"].display_name, "CLI Fresh");
        assert_eq!(state.snapshots["claude"].started_at, "2026-03-26T08:10:00Z");
        assert_eq!(state.dirty_generation, 0);
    }

    let loaded = load_cache(&dir);
    assert_eq!(loaded["claude"].display_name, "CLI Fresh");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[serial]
fn cache_successful_output_debounces_disk_writes() {
    let dir = temp_dir("debounced-cache");
    std::fs::create_dir_all(&dir).unwrap();

    init(
        &dir,
        vec!["claude".to_string(), "codex".to_string()],
        "test".to_string(),
    );
    cache_successful_output(
        &make_output("claude", "Claude"),
        time::OffsetDateTime::now_utc(),
    );
    cache_successful_output(
        &make_output("codex", "Codex"),
        time::OffsetDateTime::now_utc(),
    );

    {
        let state = cache_state().lock().unwrap();
        assert!(state.flush_scheduled);
        assert_eq!(state.dirty_generation, 2);
        assert_eq!(state.flushed_generation, 0);
    }
    assert!(
        !dir.join(CACHE_FILE_NAME).exists(),
        "cache should not be written synchronously for every result"
    );

    let loaded = wait_for_cached_snapshots(&dir, 2);
    assert_eq!(loaded["claude"].display_name, "Claude");
    assert_eq!(loaded["codex"].display_name, "Codex");

    wait_for_cache_writer_idle();

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[serial]
fn flush_cache_persists_pending_write_synchronously() {
    let dir = temp_dir("flush-cache");
    std::fs::create_dir_all(&dir).unwrap();

    init(&dir, vec!["claude".to_string()], "test".to_string());
    cache_successful_output(
        &make_output("claude", "Claude"),
        time::OffsetDateTime::now_utc(),
    );
    assert!(
        !dir.join(CACHE_FILE_NAME).exists(),
        "cache write should be pending before explicit flush"
    );

    flush_cache().unwrap();

    let loaded = load_cache(&dir);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded["claude"].display_name, "Claude");

    wait_for_cache_writer_idle();

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[serial]
fn failed_cache_write_stays_pending_for_retry() {
    let parent = temp_dir("cache-write-retry");
    std::fs::create_dir_all(&parent).unwrap();
    let blocking_file = parent.join("not-a-directory");
    std::fs::write(&blocking_file, "blocked").unwrap();
    let dir = blocking_file.join("cache");

    init(&dir, vec!["claude".to_string()], "test".to_string());
    {
        let mut state = cache_state().lock().unwrap();
        state
            .snapshots
            .insert("claude".to_string(), make_snapshot("claude", "Claude"));
        state.dirty_generation = 1;
        state.flushed_generation = 0;
        state.flush_scheduled = true;
    }

    assert!(flush_cache().is_err());
    {
        let state = cache_state().lock().unwrap();
        assert_eq!(state.dirty_generation, 1);
        assert_eq!(state.flushed_generation, 0);
        assert!(state.flush_scheduled);
    }

    std::fs::remove_file(&blocking_file).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(flush_pending_cache_once(), CacheFlushResult::Flushed);

    let loaded = load_cache(&dir);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded["claude"].display_name, "Claude");

    assert_eq!(flush_pending_cache_once(), CacheFlushResult::Idle);
    {
        let state = cache_state().lock().unwrap();
        assert_eq!(state.dirty_generation, 1);
        assert_eq!(state.flushed_generation, 1);
        assert!(!state.flush_scheduled);
    }

    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn snapshot_with_progress_line_round_trips() {
    let snap = CachedPluginSnapshot {
        provider_id: "claude".to_string(),
        display_name: "Claude".to_string(),
        plan: Some("Max 20x".to_string()),
        lines: vec![crate::plugin_engine::runtime::MetricLine::Progress {
            label: "Session".to_string(),
            limit_resource_key: None,
            used: 42.0,
            limit: 100.0,
            format: ProgressFormat::Percent,
            resets_at: Some("2026-03-26T12:00:00Z".to_string()),
            period_duration_ms: Some(14400000),
            color: None,
        }],
        started_at: "2026-03-26T08:00:00Z".to_string(),
        fetched_at: "2026-03-26T08:00:00Z".to_string(),
    };

    let json = serde_json::to_string(&snap).unwrap();
    let deserialized: CachedPluginSnapshot = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.provider_id, "claude");
    assert_eq!(deserialized.lines.len(), 1);
}
