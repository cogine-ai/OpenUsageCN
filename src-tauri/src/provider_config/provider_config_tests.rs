use super::*;
use crate::plugin_engine::manifest::{PluginConfigFieldType, PluginConfigOption};
use serial_test::serial;
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
