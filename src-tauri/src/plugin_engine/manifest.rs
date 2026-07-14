use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLine {
    #[serde(rename = "type")]
    pub line_type: String,
    pub label: String,
    pub scope: String,
    /// Lower number = higher priority for primary metric selection.
    /// Only progress lines with primary_order are candidates.
    pub primary_order: Option<u32>,
    /// Marks this line as the provider's recurring-period metric for the
    /// menubar metric preference. Currently only "weekly" is recognized.
    pub period: Option<String>,
    /// Stable, presentation-free identifier exported by `/v1/limits`.
    /// Lines without this metadata remain UI-only.
    pub limit_resource: Option<LimitResourceManifest>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LimitResourceManifest {
    pub key: String,
    #[serde(default)]
    pub kind: LimitResourceKind,
    /// Stable unit for count-formatted progress rows. Runtime suffixes are
    /// presentation strings and must not leak into the limits contract.
    pub count_unit: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LimitResourceKind {
    #[default]
    Consumption,
    Balance,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLink {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusPage {
    pub api_url: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfig {
    #[serde(default)]
    pub fields: Vec<PluginConfigField>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigField {
    pub id: String,
    #[serde(rename = "type")]
    pub field_type: PluginConfigFieldType,
    pub label: String,
    pub placeholder: Option<String>,
    pub help: Option<String>,
    #[serde(default)]
    pub options: Vec<PluginConfigOption>,
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub default_source: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginConfigFieldType {
    Secret,
    Text,
    Select,
    Toggle,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub icon: String,
    pub brand_color: Option<String>,
    pub lines: Vec<ManifestLine>,
    #[serde(default)]
    pub links: Vec<PluginLink>,
    #[serde(default)]
    pub status_page: Option<PluginStatusPage>,
    #[serde(default)]
    pub config: Option<PluginConfig>,
}

#[derive(Debug, Clone)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub plugin_dir: PathBuf,
    pub entry_script: String,
    pub icon_data_url: String,
}

pub fn load_plugins_from_dir(plugins_dir: &std::path::Path) -> Vec<LoadedPlugin> {
    let mut plugins = Vec::new();
    let entries = match std::fs::read_dir(plugins_dir) {
        Ok(e) => e,
        Err(_) => return plugins,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("plugin.json");
        if !manifest_path.exists() {
            continue;
        }
        if let Ok(p) = load_single_plugin(&path) {
            plugins.push(p);
        }
    }

    plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    plugins
}

/// Label of the progress line marked `"period": "weekly"`, if any.
/// Drives the menubar weekly-metric preference; first match wins.
pub fn weekly_candidate(lines: &[ManifestLine]) -> Option<&str> {
    lines
        .iter()
        .find(|line| line.line_type == "progress" && line.period.as_deref() == Some("weekly"))
        .map(|line| line.label.as_str())
}

fn load_single_plugin(
    plugin_dir: &std::path::Path,
) -> Result<LoadedPlugin, Box<dyn std::error::Error>> {
    let manifest_path = plugin_dir.join("plugin.json");
    let manifest_text = std::fs::read_to_string(&manifest_path)?;
    let mut manifest: PluginManifest = serde_json::from_str(&manifest_text)?;
    manifest.links = sanitize_plugin_links(&manifest.id, std::mem::take(&mut manifest.links));
    manifest.status_page = normalize_status_page(&manifest.id, manifest.status_page.take())?;
    validate_plugin_config(&manifest)?;

    validate_manifest_lines(&manifest)?;

    if manifest.entry.trim().is_empty() {
        return Err("plugin entry field cannot be empty".into());
    }
    if Path::new(&manifest.entry).is_absolute() {
        return Err("plugin entry must be a relative path".into());
    }

    let entry_path = plugin_dir.join(&manifest.entry);
    let canonical_plugin_dir = plugin_dir.canonicalize()?;
    let canonical_entry_path = entry_path.canonicalize()?;
    if !canonical_entry_path.starts_with(&canonical_plugin_dir) {
        return Err("plugin entry must remain within plugin directory".into());
    }
    if !canonical_entry_path.is_file() {
        return Err("plugin entry must be a file".into());
    }

    let entry_script = std::fs::read_to_string(&canonical_entry_path)?;

    let icon_file = plugin_dir.join(&manifest.icon);
    let icon_bytes = std::fs::read(&icon_file)?;
    let icon_data_url = format!("data:image/svg+xml;base64,{}", STANDARD.encode(&icon_bytes));

    Ok(LoadedPlugin {
        manifest,
        plugin_dir: plugin_dir.to_path_buf(),
        entry_script,
        icon_data_url,
    })
}

fn validate_manifest_lines(manifest: &PluginManifest) -> Result<(), Box<dyn std::error::Error>> {
    let mut limit_resource_keys = HashSet::new();
    for line in &manifest.lines {
        if line.primary_order.is_some() && line.line_type != "progress" {
            log::warn!(
                "plugin {} line '{}' has primaryOrder but type is '{}'; will be ignored",
                manifest.id,
                line.label,
                line.line_type
            );
        }
        if let Some(period) = line.period.as_deref() {
            if line.line_type != "progress" {
                log::warn!(
                    "plugin {} line '{}' has period but type is '{}'; will be ignored",
                    manifest.id,
                    line.label,
                    line.line_type
                );
            } else if period != "weekly" {
                log::warn!(
                    "plugin {} line '{}' has unsupported period '{}'; only \"weekly\" is recognized",
                    manifest.id,
                    line.label,
                    period
                );
            }
        }
        if let Some(resource) = line.limit_resource.as_ref() {
            if line.line_type != "progress" {
                return Err(format!(
                    "plugin {} line '{}' has limitResource but type is '{}'",
                    manifest.id, line.label, line.line_type
                )
                .into());
            }
            if !is_valid_limit_resource_key(&resource.key) {
                return Err(format!(
                    "plugin {} line '{}' has invalid limitResource key '{}'",
                    manifest.id, line.label, resource.key
                )
                .into());
            }
            if !limit_resource_keys.insert(resource.key.clone()) {
                return Err(format!(
                    "plugin {} has duplicate limitResource key '{}'",
                    manifest.id, resource.key
                )
                .into());
            }
            if resource.kind == LimitResourceKind::Balance {
                return Err(format!(
                    "plugin {} line '{}' cannot export a balance from a progress value",
                    manifest.id, line.label
                )
                .into());
            }
            if resource
                .count_unit
                .as_deref()
                .is_some_and(|unit| unit.trim().is_empty())
            {
                return Err(format!(
                    "plugin {} line '{}' has an empty limitResource countUnit",
                    manifest.id, line.label
                )
                .into());
            }
        }
    }
    Ok(())
}

fn is_valid_limit_resource_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && chars.all(|character| character.is_ascii_alphanumeric())
}

fn validate_plugin_config(manifest: &PluginManifest) -> Result<(), Box<dyn std::error::Error>> {
    let Some(config) = manifest.config.as_ref() else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    for field in config.fields.iter() {
        let id = field.id.trim();
        if id.is_empty() {
            return Err(format!("plugin {} config field id cannot be empty", manifest.id).into());
        }
        if !seen.insert(id.to_string()) {
            return Err(
                format!("plugin {} config field '{}' is duplicated", manifest.id, id).into(),
            );
        }
        if field.label.trim().is_empty() {
            return Err(format!(
                "plugin {} config field '{}' label cannot be empty",
                manifest.id, id
            )
            .into());
        }
        if field.field_type == PluginConfigFieldType::Select {
            if field.options.is_empty() {
                return Err(
                    format!("plugin {} select field '{}' needs options", manifest.id, id).into(),
                );
            }
            let mut option_values = HashSet::new();
            for option in field.options.iter() {
                let value = option.value.trim();
                if value.is_empty() {
                    return Err(format!(
                        "plugin {} select field '{}' has empty option value",
                        manifest.id, id
                    )
                    .into());
                }
                if option.label.trim().is_empty() {
                    return Err(format!(
                        "plugin {} select field '{}' option '{}' label cannot be empty",
                        manifest.id, id, value
                    )
                    .into());
                }
                if !option_values.insert(value.to_string()) {
                    return Err(format!(
                        "plugin {} select field '{}' option '{}' is duplicated",
                        manifest.id, id, value
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn normalize_status_page(
    plugin_id: &str,
    status_page: Option<PluginStatusPage>,
) -> Result<Option<PluginStatusPage>, Box<dyn std::error::Error>> {
    let Some(status_page) = status_page else {
        return Ok(None);
    };

    let status_page = PluginStatusPage {
        api_url: status_page.api_url.trim().to_string(),
        url: status_page.url.trim().to_string(),
    };
    for (field, value) in [
        ("apiUrl", status_page.api_url.as_str()),
        ("url", status_page.url.as_str()),
    ] {
        let parsed = reqwest::Url::parse(value).map_err(|error| {
            format!("plugin {plugin_id} statusPage.{field} is invalid: {error}")
        })?;
        if parsed.scheme() != "https" || parsed.host_str().is_none() {
            return Err(format!(
                "plugin {plugin_id} statusPage.{field} must be an absolute HTTPS URL"
            )
            .into());
        }
    }

    Ok(Some(status_page))
}

fn sanitize_plugin_links(plugin_id: &str, links: Vec<PluginLink>) -> Vec<PluginLink> {
    links
        .into_iter()
        .filter_map(|link| {
            let label = link.label.trim().to_string();
            let url = link.url.trim().to_string();

            if label.is_empty() || url.is_empty() {
                log::warn!(
                    "plugin {} has link with empty label/url; skipping",
                    plugin_id
                );
                return None;
            }
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                log::warn!(
                    "plugin {} link '{}' has non-http(s) url '{}'; skipping",
                    plugin_id,
                    label,
                    url
                );
                return None;
            }

            Some(PluginLink { label, url })
        })
        .collect()
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manifest_limits_tests.rs"]
mod limit_tests;
