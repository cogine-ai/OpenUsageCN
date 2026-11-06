use super::*;

pub fn save_plugin_values(
    plugin_id: &str,
    fields: &[PluginConfigField],
    input: HashMap<String, Value>,
) -> Result<(), String> {
    let path = config_path()?;
    save_plugin_values_to_path(&path, plugin_id, fields, input)
}

pub(super) fn save_plugin_values_to_path(
    path: &Path,
    plugin_id: &str,
    fields: &[PluginConfigField],
    input: HashMap<String, Value>,
) -> Result<(), String> {
    save_plugin_values_with_hook_at(path, plugin_id, fields, input, || Ok(()))
}

pub(crate) fn save_plugin_values_with_hook(
    plugin_id: &str,
    fields: &[PluginConfigField],
    input: HashMap<String, Value>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    save_plugin_values_with_hook_at(&config_path()?, plugin_id, fields, input, before_commit)
}
fn save_plugin_values_with_hook_at(
    path: &Path,
    plugin_id: &str,
    fields: &[PluginConfigField],
    input: HashMap<String, Value>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _writer = save_lock()
        .lock()
        .expect("provider config save lock poisoned");
    let _file_guard = login::lock_config_file(path)?;
    let mut next_config = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| damaged_config_message(path))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => store()
            .lock()
            .expect("provider config store poisoned")
            .clone(),
        Err(_) => return Err("无法读取连接设置，请检查文件权限。".into()),
    };
    merge_persisted_providers_if_degraded(path, &mut next_config);
    if LOAD_DEGRADED.load(Ordering::Acquire) && !has_recoverable_disk_config(path) {
        return Err(damaged_config_message(path));
    }

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

    before_commit()?;
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

pub(super) fn delete_plugin_field_from_path(
    path: &Path,
    plugin_id: &str,
    fields: &[PluginConfigField],
    field_id: &str,
) -> Result<(), String> {
    delete_plugin_field_with_hook_at(path, plugin_id, fields, field_id, || Ok(()))
}
pub(crate) fn delete_plugin_field_with_hook(
    plugin_id: &str,
    fields: &[PluginConfigField],
    field_id: &str,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    delete_plugin_field_with_hook_at(&config_path()?, plugin_id, fields, field_id, before_commit)
}
fn delete_plugin_field_with_hook_at(
    path: &Path,
    plugin_id: &str,
    fields: &[PluginConfigField],
    field_id: &str,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !fields.iter().any(|field| field.id == field_id) {
        return Err(format!(
            "Unknown config field '{field_id}' for plugin {plugin_id}"
        ));
    }
    let _writer = save_lock()
        .lock()
        .expect("provider config save lock poisoned");
    let _file_guard = login::lock_config_file(path)?;
    let mut next_config = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| damaged_config_message(path))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => store()
            .lock()
            .expect("provider config store poisoned")
            .clone(),
        Err(_) => return Err("无法读取连接设置，请检查文件权限。".into()),
    };
    merge_persisted_providers_if_degraded(path, &mut next_config);
    if LOAD_DEGRADED.load(Ordering::Acquire) && !has_recoverable_disk_config(path) {
        return Err(damaged_config_message(path));
    }
    if let Some(values) = next_config.providers.get_mut(plugin_id) {
        values.remove(field_id);
        if values.is_empty() {
            next_config.providers.remove(plugin_id);
        }
    }
    next_config.version = CONFIG_VERSION;

    before_commit()?;
    save_to_path(path, &next_config)?;
    let mut locked = store().lock().expect("provider config store poisoned");
    *locked = next_config;
    LOAD_DEGRADED.store(false, Ordering::Release);
    Ok(())
}
