use super::*;
use crate::local_http_api::cache;

fn initialize_cache(fixture: &Fixture) {
    cache::init_with_catalog(
        &fixture.dir(),
        &fixture.dir(),
        vec!["ollama".into(), "codex".into()],
        vec![],
        "test".into(),
    );
}

fn panic_result(plugin: &LoadedPlugin) -> serde_json::Value {
    serde_json::to_value(crate::ProbeResult {
        batch_id: "synthetic-panic-batch".into(),
        output: crate::plugin_engine::runtime::panic_probe_output(plugin),
        invalidate_cached_data: crate::panic_probe_invalidates_cached_data(&plugin.manifest.id),
    })
    .unwrap()
}

fn cache_quota(plugin: &LoadedPlugin) {
    cache::replace_account_projection(
        "ollama",
        Some((
            &output(plugin, Some("Verified Account".into()), vec![]),
            time::OffsetDateTime::now_utc(),
        )),
    )
    .unwrap();
}

#[test]
#[serial_test::serial]
fn a_panicked_refresh_preserves_a_valid_primary_in_both_ui_and_api() {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    let mut stored = StoredAccounts::default();
    stored.connections.push(record("current", &"a".repeat(64)));
    stored.primary = Primary::Connection {
        connection_id: "current".into(),
    };
    store::write_to(&fixture.path, &stored).unwrap();
    initialize_cache(&fixture);
    cache_quota(&plugin);
    let original = serde_json::to_value(cache::snapshot_for_provider("ollama").unwrap()).unwrap();

    let result = panic_result(&plugin);
    assert!(
        result.get("invalidateCachedData").is_none(),
        "valid cached UI data must be retained"
    );
    assert_eq!(result["output"]["lines"][0]["label"], "Error");
    assert_eq!(
        serde_json::to_value(cache::snapshot_for_provider("ollama").unwrap()).unwrap(),
        original
    );
    assert_eq!(
        cache::load_cache(&fixture.dir())["ollama"].plan.as_deref(),
        Some("Verified Account")
    );
}

#[test]
#[serial_test::serial]
fn a_panicked_refresh_invalidates_ui_and_api_if_primary_state_is_unreadable() {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    initialize_cache(&fixture);
    cache_quota(&plugin);
    std::fs::write(&fixture.path, "{damaged synthetic account state").unwrap();

    assert_eq!(panic_result(&plugin)["invalidateCachedData"], true);
    assert!(cache::snapshot_for_provider("ollama").is_none());
    assert!(!cache::load_cache(&fixture.dir()).contains_key("ollama"));
}

#[test]
#[serial_test::serial]
fn other_provider_panics_do_not_check_or_invalidate_ollama() {
    let fixture = Fixture::new();
    let mut plugin = plugin(&"a".repeat(64), 24);
    initialize_cache(&fixture);
    cache_quota(&plugin);
    std::fs::write(&fixture.path, "{damaged synthetic account state").unwrap();
    plugin.manifest.id = "codex".into();

    assert!(panic_result(&plugin).get("invalidateCachedData").is_none());
    assert!(cache::snapshot_for_provider("ollama").is_some());
    assert!(cache::load_cache(&fixture.dir()).contains_key("ollama"));
}
