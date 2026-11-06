use super::*;

fn cursor_catalog() -> ProviderLimitCatalog {
    let plugin = LoadedPlugin {
        manifest: serde_json::from_str(include_str!("../../../plugins/cursor/plugin.json"))
            .unwrap(),
        plugin_dir: std::path::PathBuf::new(),
        entry_script: String::new(),
        icon_data_url: String::new(),
    };
    catalog_from_plugins(&[plugin]).remove(0)
}

fn snapshot_with(lines: Vec<MetricLine>) -> CachedPluginSnapshot {
    CachedPluginSnapshot {
        provider_id: "cursor".into(),
        display_name: "Cursor".into(),
        plan: Some("Pro".into()),
        lines,
        started_at: "2026-11-03T00:00:00Z".into(),
        fetched_at: "2026-11-03T00:00:01Z".into(),
        config_fingerprint: None,
    }
}

fn progress(label: &str, key: &str, duration: u64) -> MetricLine {
    MetricLine::Progress {
        label: label.into(),
        limit_resource_key: Some(key.into()),
        used: 25.0,
        limit: 100.0,
        format: ProgressFormat::Percent,
        resets_at: Some("2026-11-10T00:00:00Z".into()),
        period_duration_ms: Some(duration),
        color: None,
    }
}

fn project(lines: Vec<MetricLine>) -> serde_json::Value {
    let snapshot = snapshot_with(lines);
    let now = OffsetDateTime::parse(
        "2026-11-03T00:01:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let (provider, errors) = provider_from_snapshot(&snapshot, &cursor_catalog(), now).unwrap();
    assert!(errors.is_empty());
    serde_json::to_value(provider).unwrap()
}

#[test]
fn real_cursor_manifest_projects_shared_weekly_usage_into_the_machine_contract() {
    let output = project(vec![progress("Shared Weekly Usage", "weekly", 604_800_000)]);
    assert_eq!(output["resources"]["weekly"]["unit"], "percent");
    assert_eq!(output["resources"]["weekly"]["used"], 25.0);
    assert_eq!(output["resources"]["weekly"]["remaining"], 75.0);
    assert_eq!(output["resources"]["weekly"]["windowSeconds"], 604_800.0);
    assert_eq!(
        output["resources"]["weekly"]["resetsAt"],
        "2026-11-10T00:00:00Z"
    );
    assert_eq!(output["resources"].as_object().unwrap().len(), 1);
}

#[test]
fn legacy_cursor_total_and_grok_windows_do_not_become_shared_weekly_usage() {
    let output = project(vec![
        progress("Total usage", "totalUsage", 2_592_000_000),
        progress("Grok Bot", "grokBotUsage", 604_800_000),
    ]);
    assert!(output["resources"].get("weekly").is_none());
    assert!(output["resources"].get("totalUsage").is_some());
    assert_eq!(
        output["resources"]["grokBotUsage"]["windowSeconds"],
        604_800.0
    );
}
