use super::cache::{CacheState, DEFAULT_ENABLED_PLUGINS, SETTINGS_FILE_NAME};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Deserialize)]
struct SettingsFile {
    plugins: Option<PluginSettingsJson>,
}

#[derive(Deserialize)]
struct PluginSettingsJson {
    order: Option<Vec<String>>,
    disabled: Option<Vec<String>>,
}

fn read_plugin_settings(app_data_dir: &Path) -> (Vec<String>, HashSet<String>, bool) {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    let data = match std::fs::read_to_string(&path) {
        Ok(data) => data,
        Err(_) => return (Vec::new(), HashSet::new(), false),
    };
    match serde_json::from_str::<SettingsFile>(&data) {
        Ok(settings) => {
            let plugins = settings.plugins.unwrap_or(PluginSettingsJson {
                order: None,
                disabled: None,
            });
            let has_settings = plugins.order.is_some() || plugins.disabled.is_some();
            let order = plugins.order.unwrap_or_default();
            let disabled = plugins.disabled.unwrap_or_default().into_iter().collect();
            (order, disabled, has_settings)
        }
        Err(_) => (Vec::new(), HashSet::new(), false),
    }
}

pub(super) fn enabled_plugin_ids_ordered(state: &CacheState) -> Vec<String> {
    let (settings_order, disabled, has_settings) = read_plugin_settings(&state.app_data_dir);
    let default_enabled: HashSet<&str> = DEFAULT_ENABLED_PLUGINS.iter().copied().collect();
    let is_enabled = |id: &str| {
        if has_settings {
            !disabled.contains(id)
        } else {
            default_enabled.contains(id)
        }
    };

    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    for id in settings_order.iter().chain(&state.known_plugin_ids) {
        if seen.insert(id.clone()) {
            ordered.push(id.clone());
        }
    }
    ordered.into_iter().filter(|id| is_enabled(id)).collect()
}
