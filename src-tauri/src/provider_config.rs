use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::{LoadedPlugin, PluginConfigField, PluginConfigFieldType};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

static LOAD_DEGRADED: AtomicBool = AtomicBool::new(false);

const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    providers: HashMap<String, HashMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigView {
    pub values: HashMap<String, ProviderConfigViewValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderConfigViewValue {
    Secret {
        configured: bool,
        hint: Option<String>,
    },
    Text {
        value: Option<String>,
    },
    Select {
        value: String,
    },
    Toggle {
        value: bool,
    },
}

fn store() -> &'static Mutex<ProviderConfigFile> {
    static STORE: OnceLock<Mutex<ProviderConfigFile>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(load_from_default_path()))
}

fn save_lock() -> &'static Mutex<()> {
    static SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    SAVE_LOCK.get_or_init(|| Mutex::new(()))
}

fn default_file() -> ProviderConfigFile {
    ProviderConfigFile {
        version: CONFIG_VERSION,
        providers: HashMap::new(),
    }
}

pub fn config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".openusagecn").join("providers.json"))
        .ok_or_else(|| "No home directory found".to_string())
}

fn load_from_default_path() -> ProviderConfigFile {
    let Ok(path) = config_path() else {
        log::warn!("[provider-config] no home directory, using empty provider config");
        return default_file();
    };
    let mut config = load_from_path(&path);
    merge_persisted_providers_if_degraded(&path, &mut config);
    config
}

fn load_from_path(path: &Path) -> ProviderConfigFile {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            LOAD_DEGRADED.store(false, Ordering::Release);
            return default_file();
        }
        Err(err) => {
            log::warn!(
                "[provider-config] failed to read {}: {}, using empty provider config",
                path.display(),
                err
            );
            LOAD_DEGRADED.store(true, Ordering::Release);
            return default_file();
        }
    };
    match serde_json::from_str::<ProviderConfigFile>(&contents) {
        Ok(mut config) => {
            LOAD_DEGRADED.store(false, Ordering::Release);
            config.version = CONFIG_VERSION;
            config
        }
        Err(err) => {
            log::warn!(
                "[provider-config] failed to parse {}: {}, using empty provider config",
                path.display(),
                err
            );
            let backup = path.with_extension("json.bak");
            if !backup.exists() {
                if let Err(copy_err) = std::fs::copy(path, &backup) {
                    log::warn!(
                        "[provider-config] failed to back up damaged config {}: {}",
                        path.display(),
                        copy_err
                    );
                }
            }
            LOAD_DEGRADED.store(true, Ordering::Release);
            default_file()
        }
    }
}

fn try_parse_config_file(path: &Path) -> Option<ProviderConfigFile> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<ProviderConfigFile>(&contents).ok()
}

fn merge_persisted_providers_if_degraded(path: &Path, config: &mut ProviderConfigFile) {
    if !LOAD_DEGRADED.load(Ordering::Acquire) {
        return;
    }

    let backup = path.with_extension("json.bak");
    for source in [path, backup.as_path()] {
        let Some(disk) = try_parse_config_file(source) else {
            continue;
        };
        for (id, values) in disk.providers {
            config.providers.entry(id).or_insert(values);
        }
    }
}

fn save_to_path(path: &Path, config: &ProviderConfigFile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid provider config path: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create provider config directory: {err}"))?;

    let text = serde_json::to_string_pretty(config)
        .map_err(|err| format!("Failed to encode provider config: {err}"))?;
    let temp = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4()));
    {
        use std::io::Write as _;

        let mut file = create_private_temp_file(&temp)?;
        file.write_all(text.as_bytes())
            .map_err(|err| format!("Failed to write provider config: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("Failed to sync provider config: {err}"))?;
    }
    set_private_permissions(&temp);
    std::fs::rename(&temp, path)
        .map_err(|err| format!("Failed to replace provider config: {err}"))?;
    set_private_permissions(path);
    Ok(())
}

fn create_private_temp_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    options
        .open(path)
        .map_err(|err| format!("Failed to create provider config temp file: {err}"))
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        let _ = std::fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) {}

pub fn register_existing_secrets(plugins: &[LoadedPlugin]) {
    let config = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.clone()
    };
    for plugin in plugins {
        let Some(plugin_config) = plugin.manifest.config.as_ref() else {
            continue;
        };
        let Some(values) = config.providers.get(&plugin.manifest.id) else {
            continue;
        };
        register_secret_values(&plugin_config.fields, values);
    }
}

pub fn resolved_values(plugin_id: &str, fields: &[PluginConfigField]) -> HashMap<String, Value> {
    let stored = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.providers.get(plugin_id).cloned().unwrap_or_default()
    };
    resolve_values(fields, &stored)
}

pub fn view_for_plugin(plugin_id: &str, fields: &[PluginConfigField]) -> ProviderConfigView {
    let stored = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.providers.get(plugin_id).cloned().unwrap_or_default()
    };
    let resolved = resolve_values(fields, &stored);
    let mut values = HashMap::new();
    for field in fields {
        let value = resolved.get(&field.id);
        let view = match field.field_type {
            PluginConfigFieldType::Secret => {
                let configured = value.and_then(Value::as_str).is_some_and(|s| !s.is_empty());
                ProviderConfigViewValue::Secret {
                    configured,
                    hint: value.and_then(Value::as_str).map(secret_hint),
                }
            }
            PluginConfigFieldType::Text => ProviderConfigViewValue::Text {
                value: value.and_then(Value::as_str).map(str::to_string),
            },
            PluginConfigFieldType::Select => ProviderConfigViewValue::Select {
                value: value
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            },
            PluginConfigFieldType::Toggle => ProviderConfigViewValue::Toggle {
                value: value.and_then(Value::as_bool).unwrap_or(false),
            },
        };
        values.insert(field.id.clone(), view);
    }
    ProviderConfigView { values }
}

pub fn save_plugin_values(
    plugin_id: &str,
    fields: &[PluginConfigField],
    input: HashMap<String, Value>,
) -> Result<(), String> {
    let path = config_path()?;
    save_plugin_values_to_path(&path, plugin_id, fields, input)
}

fn save_plugin_values_to_path(
    path: &Path,
    plugin_id: &str,
    fields: &[PluginConfigField],
    input: HashMap<String, Value>,
) -> Result<(), String> {
    let _writer = save_lock()
        .lock()
        .expect("provider config save lock poisoned");
    let mut next_config = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.clone()
    };
    merge_persisted_providers_if_degraded(path, &mut next_config);

    let existing = next_config
        .providers
        .get(plugin_id)
        .cloned()
        .unwrap_or_default();
    let merged = merge_values(fields, existing, input)?;
    if merged.is_empty() {
        next_config.providers.remove(plugin_id);
    } else {
        next_config.providers.insert(plugin_id.to_string(), merged);
    }
    next_config.version = CONFIG_VERSION;

    save_to_path(path, &next_config)?;

    {
        let mut locked = store().lock().expect("provider config store poisoned");
        *locked = next_config.clone();
    }
    LOAD_DEGRADED.store(false, Ordering::Release);
    if let Some(values) = next_config.providers.get(plugin_id) {
        register_secret_values(fields, values);
    }
    Ok(())
}

pub fn delete_plugin_field(
    plugin_id: &str,
    fields: &[PluginConfigField],
    field_id: &str,
) -> Result<(), String> {
    let path = config_path()?;
    delete_plugin_field_from_path(&path, plugin_id, fields, field_id)
}

fn delete_plugin_field_from_path(
    path: &Path,
    plugin_id: &str,
    fields: &[PluginConfigField],
    field_id: &str,
) -> Result<(), String> {
    if !fields.iter().any(|field| field.id == field_id) {
        return Err(format!(
            "Unknown config field '{field_id}' for plugin {plugin_id}"
        ));
    }
    let _writer = save_lock()
        .lock()
        .expect("provider config save lock poisoned");
    let mut next_config = {
        let locked = store().lock().expect("provider config store poisoned");
        locked.clone()
    };
    merge_persisted_providers_if_degraded(path, &mut next_config);
    if let Some(values) = next_config.providers.get_mut(plugin_id) {
        values.remove(field_id);
        if values.is_empty() {
            next_config.providers.remove(plugin_id);
        }
    }
    next_config.version = CONFIG_VERSION;

    save_to_path(path, &next_config)?;
    let mut locked = store().lock().expect("provider config store poisoned");
    *locked = next_config;
    LOAD_DEGRADED.store(false, Ordering::Release);
    Ok(())
}

#[cfg(test)]
pub(super) fn reset_load_state_for_test() {
    LOAD_DEGRADED.store(false, Ordering::Release);
}

#[cfg(test)]
pub(super) fn set_load_degraded_for_test(degraded: bool) {
    LOAD_DEGRADED.store(degraded, Ordering::Release);
}

fn merge_values(
    fields: &[PluginConfigField],
    existing: HashMap<String, Value>,
    input: HashMap<String, Value>,
) -> Result<HashMap<String, Value>, String> {
    let mut merged = HashMap::new();
    for field in fields {
        let Some(raw) = input.get(&field.id) else {
            if let Some(value) = existing.get(&field.id) {
                merged.insert(field.id.clone(), value.clone());
            }
            continue;
        };

        match field.field_type {
            PluginConfigFieldType::Secret => {
                if let Some(cleaned) = clean_string(raw) {
                    merged.insert(field.id.clone(), Value::String(cleaned));
                } else if let Some(value) = existing.get(&field.id) {
                    merged.insert(field.id.clone(), value.clone());
                }
            }
            PluginConfigFieldType::Text => {
                if let Some(cleaned) = clean_string(raw) {
                    merged.insert(field.id.clone(), Value::String(cleaned));
                }
            }
            PluginConfigFieldType::Select => {
                let Some(cleaned) = clean_string(raw) else {
                    continue;
                };
                if !field.options.iter().any(|option| option.value == cleaned) {
                    return Err(format!(
                        "Invalid value '{}' for config field '{}'",
                        cleaned, field.id
                    ));
                }
                merged.insert(field.id.clone(), Value::String(cleaned));
            }
            PluginConfigFieldType::Toggle => {
                let value = raw.as_bool().ok_or_else(|| {
                    format!("Invalid boolean value for config field '{}'", field.id)
                })?;
                merged.insert(field.id.clone(), Value::Bool(value));
            }
        }
    }
    Ok(merged)
}

fn resolve_values(
    fields: &[PluginConfigField],
    stored: &HashMap<String, Value>,
) -> HashMap<String, Value> {
    let mut resolved = HashMap::new();
    for field in fields {
        if let Some(value) = normalized_stored_value(field, stored.get(&field.id)) {
            resolved.insert(field.id.clone(), value);
            continue;
        }
        if let Some(value) = normalized_default_value(field) {
            resolved.insert(field.id.clone(), value);
        }
    }
    register_secret_values(fields, &resolved);
    resolved
}

fn normalized_stored_value(field: &PluginConfigField, value: Option<&Value>) -> Option<Value> {
    match field.field_type {
        PluginConfigFieldType::Secret | PluginConfigFieldType::Text => {
            value.and_then(clean_string).map(Value::String)
        }
        PluginConfigFieldType::Select => {
            let cleaned = value.and_then(clean_string)?;
            if field.options.iter().any(|option| option.value == cleaned) {
                Some(Value::String(cleaned))
            } else {
                None
            }
        }
        PluginConfigFieldType::Toggle => value.and_then(Value::as_bool).map(Value::Bool),
    }
}

fn normalized_default_value(field: &PluginConfigField) -> Option<Value> {
    match field.field_type {
        PluginConfigFieldType::Secret | PluginConfigFieldType::Text => field
            .default
            .as_ref()
            .and_then(clean_string)
            .map(Value::String),
        PluginConfigFieldType::Select => {
            let default = field.default.as_ref().and_then(clean_string);
            if let Some(value) = default {
                if field.options.iter().any(|option| option.value == value) {
                    return Some(Value::String(value));
                }
            }
            field
                .options
                .first()
                .map(|option| Value::String(option.value.clone()))
        }
        PluginConfigFieldType::Toggle => Some(Value::Bool(
            field
                .default
                .as_ref()
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )),
    }
}

fn clean_string(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn register_secret_values(fields: &[PluginConfigField], values: &HashMap<String, Value>) {
    for field in fields {
        if field.field_type != PluginConfigFieldType::Secret {
            continue;
        }
        if let Some(value) = values.get(&field.id).and_then(Value::as_str) {
            host_api::register_secret_for_redaction(value);
        }
    }
}

fn secret_hint(value: &str) -> String {
    let trimmed = value.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 4 {
        "已配置".to_string()
    } else {
        let last4: String = chars[chars.len() - 4..].iter().collect();
        format!("...{last4}")
    }
}

#[cfg(test)]
mod provider_config_tests;
