use super::*;

fn fields() -> Vec<PluginConfigField> {
    serde_json::from_value(serde_json::json!([
        {"id":"source","type":"select","label":"Source","default":"cookie","options":[{"value":"cookie","label":"Cookie"},{"value":"apiKey","label":"API Key"}]},
        {"id":"apiKey","type":"secret","label":"API Key"}
    ])).unwrap()
}

#[test]
fn fresh_request_settings_observe_a_later_process_write_without_rewriting_the_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("providers.json");
    for secret in ["synthetic-first", "synthetic-second"] {
        let data=serde_json::json!({"version":1,"providers":{"ollama":{"source":"apiKey","apiKey":secret}}}).to_string();
        std::fs::write(&path, &data).unwrap();
        let resolved = resolved_values_from_path(&path, "ollama", &fields()).unwrap();
        assert_eq!(resolved["apiKey"], secret);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), data);
        assert!(!host_api::redact_log_message(secret).contains(secret));
    }
    assert!(!path.with_extension("json.bak").exists());
}

#[test]
fn missing_settings_have_defaults_but_unreadable_or_damaged_settings_do_not_fall_back() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("providers.json");
    assert_eq!(
        resolved_values_from_path(&path, "ollama", &fields()).unwrap()["source"],
        "cookie"
    );
    std::fs::write(&path, "{damaged-settings").unwrap();
    let error = resolved_values_from_path(&path, "ollama", &fields()).unwrap_err();
    assert!(!error.contains("{damaged-settings"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{damaged-settings");
    assert!(!path.with_extension("json.bak").exists());
    assert!(resolved_values_from_path(directory.path(), "ollama", &fields()).is_err());
}
