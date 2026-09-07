use super::*;
use crate::plugin_engine::manifest::PluginManifest;

fn plugin(script: &str) -> LoadedPlugin {
    LoadedPlugin {
        manifest: PluginManifest {
            schema_version: 1,
            id: "synthetic".to_string(),
            name: "Fixture".to_string(),
            version: "0.0.0".to_string(),
            entry: "plugin.js".to_string(),
            icon: "icon.svg".to_string(),
            brand_color: None,
            lines: vec![],
            links: vec![],
            status_page: None,
            config: None,
            account_support: None,
        },
        plugin_dir: PathBuf::from("."),
        entry_script: script.to_string(),
        icon_data_url: String::new(),
    }
}

#[test]
fn history_failure_is_independent_from_quota_and_has_its_own_deadline() {
    let plugin = plugin(
        r#"
        globalThis.__openusage_plugin = {
            probe: () => ({ lines: [{ type: "text", label: "Quota", value: "Ready" }] }),
            probeHistory: () => { while (true) {} }
        };
    "#,
    );
    let dir = std::env::temp_dir();
    let quota = run_probe(&plugin, &dir, "0.0.0");
    assert!(probe_error_message(&quota).is_none());
    let started = Instant::now();
    let history = run_probe_with_timeout_and_connection(
        &plugin,
        &dir,
        "0.0.0",
        Duration::from_millis(25),
        None,
        "probeHistory",
    );
    assert!(probe_error_message(&history).unwrap().contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(probe_error_message(&run_probe(&plugin, &dir, "0.0.0")).is_none());
}

#[test]
fn local_history_receives_the_exact_connection_generation_without_running_quota() {
    let plugin = plugin(
        r#"
        globalThis.__openusage_plugin = {
            probe: () => { throw "quota must not run"; },
            probeHistory: (_, target) => ({ lines: [{
                type: "text", label: target.connectionKey, value: target.credentialGeneration
            }] })
        };
    "#,
    );
    let output = run_local_history(
        &plugin,
        &std::env::temp_dir(),
        "0.0.0",
        Some(("local", "generation")),
    );
    assert!(
        matches!(&output.lines[0], MetricLine::Text { label, value, .. } if label == "local" && value == "generation")
    );
}

#[test]
fn missing_history_export_does_not_fall_back_to_quota() {
    let plugin = plugin(
        r#"
        globalThis.__openusage_plugin = {
            probe: () => ({ lines: [{ type: "text", label: "Quota", value: "Ready" }] })
        };
    "#,
    );
    let history = run_local_history(&plugin, &std::env::temp_dir(), "0.0.0", None);
    assert_eq!(
        probe_error_message(&history),
        Some("missing probeHistory()")
    );
}
