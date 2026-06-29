use super::*;
use crate::plugin_engine::manifest::{PluginConfigFieldType, PluginConfigOption};
use serial_test::serial;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

fn field(id: &str, field_type: PluginConfigFieldType) -> PluginConfigField {
    PluginConfigField {
        id: id.to_string(),
        field_type,
        label: id.to_string(),
        placeholder: None,
        help: None,
        options: Vec::new(),
        default: None,
    }
}

fn select_field(default: Option<&str>) -> PluginConfigField {
    PluginConfigField {
        id: "region".to_string(),
        field_type: PluginConfigFieldType::Select,
        label: "Region".to_string(),
        placeholder: None,
        help: None,
        options: vec![
            PluginConfigOption {
                value: "cn".to_string(),
                label: "CN".to_string(),
            },
            PluginConfigOption {
                value: "global".to_string(),
                label: "Global".to_string(),
            },
        ],
        default: default.map(|value| Value::String(value.to_string())),
    }
}

fn temp_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("openusagecn-provider-config-{label}-{nanos}"))
}

fn replace_store_for_test(config: ProviderConfigFile) {
    let mut locked = store().lock().expect("provider config store poisoned");
    *locked = config;
    reset_load_state_for_test();
}

fn secret_input(value: &str) -> HashMap<String, Value> {
    HashMap::from([("apiKey".to_string(), Value::String(value.to_string()))])
}

#[cfg(unix)]
#[test]
fn private_temp_file_is_private_before_writes() {
    use std::os::unix::fs::PermissionsExt;

    let path = temp_path("private-temp");
    let file = create_private_temp_file(&path).expect("create temp file");
    let mode = std::fs::metadata(&path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    drop(file);
    let _ = std::fs::remove_file(&path);

    assert_eq!(mode, 0o600);
}

#[test]
fn resolve_values_uses_defaults_by_type() {
    let fields = vec![
        select_field(Some("global")),
        field("enabled", PluginConfigFieldType::Toggle),
    ];
    let resolved = resolve_values(&fields, &HashMap::new());
    assert_eq!(
        resolved.get("region").and_then(Value::as_str),
        Some("global")
    );
    assert_eq!(
        resolved.get("enabled").and_then(Value::as_bool),
        Some(false)
    );
}

#[test]
fn resolve_select_falls_back_when_stored_value_is_invalid() {
    let fields = vec![select_field(Some("cn"))];
    let stored = HashMap::from([("region".to_string(), Value::String("old".to_string()))]);
    let resolved = resolve_values(&fields, &stored);
    assert_eq!(resolved.get("region").and_then(Value::as_str), Some("cn"));
}

#[test]
fn secret_merge_preserves_existing_on_empty_input() {
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let existing = HashMap::from([(
        "apiKey".to_string(),
        Value::String("secret-key".to_string()),
    )]);
    let input = HashMap::from([("apiKey".to_string(), Value::String("   ".to_string()))]);
    let merged = merge_values(&fields, existing, input).expect("merge");
    assert_eq!(
        merged.get("apiKey").and_then(Value::as_str),
        Some("secret-key")
    );
}

#[test]
fn secret_merge_overwrites_on_non_empty_input() {
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let existing = HashMap::from([(
        "apiKey".to_string(),
        Value::String("old-secret".to_string()),
    )]);
    let input = HashMap::from([(
        "apiKey".to_string(),
        Value::String("new-secret".to_string()),
    )]);
    let merged = merge_values(&fields, existing, input).expect("merge");
    assert_eq!(
        merged.get("apiKey").and_then(Value::as_str),
        Some("new-secret")
    );
}

#[test]
#[serial]
fn save_write_failure_keeps_memory_cache_unchanged() {
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let old_values = HashMap::from([(
        "apiKey".to_string(),
        Value::String("old-secret".to_string()),
    )]);
    let original = ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::from([("bigmodel-cn".to_string(), old_values.clone())]),
    };
    replace_store_for_test(original);

    let blocked_parent = temp_path("blocked-parent");
    std::fs::write(&blocked_parent, "not a directory").expect("write blocker file");
    let result = save_plugin_values_to_path(
        &blocked_parent.join("providers.json"),
        "bigmodel-cn",
        &fields,
        HashMap::from([(
            "apiKey".to_string(),
            Value::String("new-secret".to_string()),
        )]),
    );
    let cached = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.providers.get("bigmodel-cn").cloned()
    };
    let _ = std::fs::remove_file(&blocked_parent);
    replace_store_for_test(default_file());

    assert!(result.is_err());
    assert_eq!(cached, Some(old_values));
}

#[test]
#[serial]
fn load_missing_version_uses_current_version() {
    let dir = temp_path("missing-version");
    let path = dir.join("providers.json");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(
        &path,
        r#"{"providers":{"bigmodel-cn":{"apiKey":"secret-key"}}}"#,
    )
    .expect("write config");

    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(loaded.version, CONFIG_VERSION);
    assert_eq!(
        loaded
            .providers
            .get("bigmodel-cn")
            .and_then(|values| values.get("apiKey"))
            .and_then(Value::as_str),
        Some("secret-key")
    );
}

#[test]
#[serial]
fn damaged_config_is_backed_up_before_fallback() {
    let dir = temp_path("damaged-backup");
    let path = dir.join("providers.json");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(&path, "{bad json").expect("write damaged config");

    let loaded = load_from_path(&path);
    let backup = path.with_extension("json.bak");
    let backup_text = std::fs::read_to_string(&backup).expect("read backup");
    let _ = std::fs::remove_dir_all(&dir);

    assert!(loaded.providers.is_empty());
    assert_eq!(backup_text, "{bad json");
    reset_load_state_for_test();
}

#[test]
#[serial]
fn load_recovers_from_valid_backup_when_main_is_corrupt() {
    let dir = temp_path("recover-from-backup");
    let path = dir.join("providers.json");
    let backup = path.with_extension("json.bak");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(&path, "{bad json").expect("write damaged config");
    std::fs::write(
        &backup,
        r#"{"version":1,"providers":{"bigmodel-cn":{"apiKey":"backup-key"}}}"#,
    )
    .expect("write backup");

    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);
    reset_load_state_for_test();

    assert_eq!(
        loaded
            .providers
            .get("bigmodel-cn")
            .and_then(|values| values.get("apiKey"))
            .and_then(Value::as_str),
        Some("backup-key")
    );
}

#[test]
#[serial]
fn save_refuses_when_disk_config_is_fully_unrecoverable() {
    replace_store_for_test(default_file());
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let dir = temp_path("fully-corrupt-save");
    let path = dir.join("providers.json");
    let backup = path.with_extension("json.bak");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(&path, "{bad json").expect("write damaged config");
    std::fs::write(&backup, "also bad").expect("write damaged backup");

    let _ = load_from_path(&path);
    let result = save_plugin_values_to_path(&path, "zai", &fields, secret_input("new-zai-key"));
    let disk_text = std::fs::read_to_string(&path).expect("read config");
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    let err = result.expect_err("save should fail");
    assert!(
        err.contains("damaged and cannot be recovered"),
        "unexpected error: {err}"
    );
    assert_eq!(disk_text, "{bad json");
}

#[test]
#[serial]
fn delete_refuses_when_disk_config_is_fully_unrecoverable() {
    replace_store_for_test(ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::from([("bigmodel-cn".to_string(), secret_input("existing-key"))]),
    });
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let dir = temp_path("fully-corrupt-delete");
    let path = dir.join("providers.json");
    let backup = path.with_extension("json.bak");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(&path, "{bad json").expect("write damaged config");
    std::fs::write(&backup, "also bad").expect("write damaged backup");

    let _ = load_from_path(&path);
    let result = delete_plugin_field_from_path(&path, "bigmodel-cn", &fields, "apiKey");
    let disk_text = std::fs::read_to_string(&path).expect("read config");
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    let err = result.expect_err("delete should fail");
    assert!(
        err.contains("damaged and cannot be recovered"),
        "unexpected error: {err}"
    );
    assert_eq!(disk_text, "{bad json");
}

#[test]
#[serial]
fn save_after_degraded_load_preserves_other_providers_on_disk() {
    replace_store_for_test(default_file());
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let dir = temp_path("degraded-load-save");
    let path = dir.join("providers.json");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(
        &path,
        r#"{"version":1,"providers":{"bigmodel-cn":{"apiKey":"existing-key"}}}"#,
    )
    .expect("write config");

    set_load_degraded_for_test(true);
    save_plugin_values_to_path(&path, "zai", &fields, secret_input("new-zai-key"))
        .expect("save provider config");

    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    assert_eq!(
        loaded
            .providers
            .get("bigmodel-cn")
            .and_then(|values| values.get("apiKey"))
            .and_then(Value::as_str),
        Some("existing-key")
    );
    assert_eq!(
        loaded
            .providers
            .get("zai")
            .and_then(|values| values.get("apiKey"))
            .and_then(Value::as_str),
        Some("new-zai-key")
    );
}

#[test]
#[serial]
fn save_round_trip_persists_values() {
    replace_store_for_test(default_file());
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let dir = temp_path("round-trip");
    let path = dir.join("providers.json");

    save_plugin_values_to_path(&path, "bigmodel-cn", &fields, secret_input("secret-key"))
        .expect("save provider config");
    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    assert_eq!(
        loaded
            .providers
            .get("bigmodel-cn")
            .and_then(|values| values.get("apiKey"))
            .and_then(Value::as_str),
        Some("secret-key")
    );
}

#[test]
#[serial]
fn delete_after_degraded_load_preserves_other_providers_on_disk() {
    replace_store_for_test(ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::from([
            ("bigmodel-cn".to_string(), secret_input("existing-key")),
            ("zai".to_string(), secret_input("zai-key")),
        ]),
    });
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let dir = temp_path("degraded-load-delete");
    let path = dir.join("providers.json");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(
        &path,
        r#"{"version":1,"providers":{"bigmodel-cn":{"apiKey":"existing-key"},"zai":{"apiKey":"zai-key"}}}"#,
    )
    .expect("write config");

    set_load_degraded_for_test(true);
    delete_plugin_field_from_path(&path, "zai", &fields, "apiKey").expect("delete provider field");

    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    assert_eq!(
        loaded
            .providers
            .get("bigmodel-cn")
            .and_then(|values| values.get("apiKey"))
            .and_then(Value::as_str),
        Some("existing-key")
    );
    assert!(loaded.providers.get("zai").is_none());
}

#[test]
fn merge_values_rejects_invalid_select_option() {
    let fields = vec![select_field(Some("cn"))];
    let result = merge_values(
        &fields,
        HashMap::new(),
        HashMap::from([("region".to_string(), Value::String("invalid".to_string()))]),
    );
    let err = result.expect_err("merge should fail");
    assert!(
        err.contains("Invalid value 'invalid' for config field 'region'"),
        "unexpected error: {err}"
    );
}

#[test]
fn merge_values_rejects_non_boolean_toggle() {
    let fields = vec![field("enabled", PluginConfigFieldType::Toggle)];
    let result = merge_values(
        &fields,
        HashMap::new(),
        HashMap::from([("enabled".to_string(), Value::String("yes".to_string()))]),
    );
    let err = result.expect_err("merge should fail");
    assert!(
        err.contains("Invalid boolean value for config field 'enabled'"),
        "unexpected error: {err}"
    );
}

#[test]
#[serial]
fn delete_plugin_field_removes_value_from_cache_and_disk() {
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    replace_store_for_test(ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::from([("bigmodel-cn".to_string(), secret_input("secret-key"))]),
    });
    let dir = temp_path("delete-field");
    let path = dir.join("providers.json");

    delete_plugin_field_from_path(&path, "bigmodel-cn", &fields, "apiKey")
        .expect("delete provider config field");
    let cached = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.providers.get("bigmodel-cn").cloned()
    };
    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    assert!(cached.is_none());
    assert!(loaded.providers.get("bigmodel-cn").is_none());
}

#[test]
#[serial]
fn concurrent_saves_keep_all_provider_updates() {
    replace_store_for_test(default_file());
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];
    let dir = temp_path("concurrent-saves");
    let path = dir.join("providers.json");
    let barrier = Arc::new(Barrier::new(8));

    let handles: Vec<_> = (0..8)
        .map(|index| {
            let fields = fields.clone();
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                let plugin_id = format!("provider-{index}");
                let value = format!("secret-{index}");
                save_plugin_values_to_path(&path, &plugin_id, &fields, secret_input(&value))
                    .expect("save provider config");
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("join save thread");
    }

    let cached = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.providers.clone()
    };
    let loaded = load_from_path(&path);
    let _ = std::fs::remove_dir_all(&dir);
    replace_store_for_test(default_file());

    assert_eq!(cached.len(), 8);
    assert_eq!(loaded.providers.len(), 8);
    for index in 0..8 {
        let plugin_id = format!("provider-{index}");
        let value = format!("secret-{index}");
        assert_eq!(
            cached
                .get(&plugin_id)
                .and_then(|values| values.get("apiKey"))
                .and_then(Value::as_str),
            Some(value.as_str())
        );
        assert_eq!(
            loaded
                .providers
                .get(&plugin_id)
                .and_then(|values| values.get("apiKey"))
                .and_then(Value::as_str),
            Some(value.as_str())
        );
    }
}

#[test]
#[serial]
fn view_for_plugin_masks_short_secrets_without_hint_suffix() {
    replace_store_for_test(ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::from([("bigmodel-cn".to_string(), secret_input("abcd"))]),
    });
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];

    let view = view_for_plugin("bigmodel-cn", &fields);
    replace_store_for_test(default_file());

    match view.values.get("apiKey") {
        Some(ProviderConfigViewValue::Secret { configured, hint }) => {
            assert!(configured);
            assert!(hint.is_none());
        }
        other => panic!("expected secret view, got {other:?}"),
    }
}

#[test]
#[serial]
fn view_for_plugin_masks_long_secrets_with_last_four_chars() {
    replace_store_for_test(ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::from([("bigmodel-cn".to_string(), secret_input("sk-live-1234abcd"))]),
    });
    let fields = vec![field("apiKey", PluginConfigFieldType::Secret)];

    let view = view_for_plugin("bigmodel-cn", &fields);
    replace_store_for_test(default_file());

    match view.values.get("apiKey") {
        Some(ProviderConfigViewValue::Secret { configured, hint }) => {
            assert!(configured);
            assert_eq!(hint.as_deref(), Some("...abcd"));
        }
        other => panic!("expected secret view, got {other:?}"),
    }
}
