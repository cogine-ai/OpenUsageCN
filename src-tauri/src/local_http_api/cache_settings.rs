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

#[derive(Debug, Clone)]
pub(super) struct CachedPluginSettings {
    pub order: Vec<String>,
    pub disabled: HashSet<String>,
}

enum PluginSettingsRead {
    /// Valid settings.json with an explicit plugins order and/or disabled list.
    Present(CachedPluginSettings),
    /// Readable JSON that does not define plugin preferences yet.
    Absent,
    /// Missing, unreadable, or temporarily invalid (e.g. mid-write truncation).
    Unavailable,
}

fn read_plugin_settings(app_data_dir: &Path) -> PluginSettingsRead {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    let data = match std::fs::read_to_string(&path) {
        Ok(data) => data,
        Err(_) => return PluginSettingsRead::Unavailable,
    };
    match serde_json::from_str::<SettingsFile>(&data) {
        Ok(settings) => {
            let plugins = settings.plugins.unwrap_or(PluginSettingsJson {
                order: None,
                disabled: None,
            });
            let has_settings = plugins.order.is_some() || plugins.disabled.is_some();
            if !has_settings {
                return PluginSettingsRead::Absent;
            }
            PluginSettingsRead::Present(CachedPluginSettings {
                order: plugins.order.unwrap_or_default(),
                disabled: plugins.disabled.unwrap_or_default().into_iter().collect(),
            })
        }
        Err(_) => PluginSettingsRead::Unavailable,
    }
}

fn resolve_enabled_plugin_ids(
    state: &CacheState,
    settings_order: &[String],
    disabled: &HashSet<String>,
    has_settings: bool,
) -> Vec<String> {
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

pub(super) fn enabled_plugin_ids_ordered(state: &mut CacheState) -> Vec<String> {
    match read_plugin_settings(&state.settings_data_dir) {
        PluginSettingsRead::Present(settings) => {
            state.last_plugin_settings = Some(settings.clone());
            resolve_enabled_plugin_ids(state, &settings.order, &settings.disabled, true)
        }
        PluginSettingsRead::Absent => {
            state.last_plugin_settings = None;
            resolve_enabled_plugin_ids(state, &[], &HashSet::new(), false)
        }
        PluginSettingsRead::Unavailable => {
            if let Some(settings) = state.last_plugin_settings.clone() {
                log::warn!(
                    "settings.json unavailable while serving local HTTP API; using last known plugin preferences"
                );
                resolve_enabled_plugin_ids(state, &settings.order, &settings.disabled, true)
            } else {
                resolve_enabled_plugin_ids(state, &[], &HashSet::new(), false)
            }
        }
    }
}
