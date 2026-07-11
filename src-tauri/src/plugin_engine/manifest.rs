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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLink {
    pub label: String,
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
    validate_plugin_config(&manifest)?;

    // Validate primary_order / period: only progress lines can carry them,
    // and period currently only recognizes "weekly".
    for line in manifest.lines.iter() {
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
    }

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
mod tests {
    use super::*;

    fn parse_manifest(json: &str) -> PluginManifest {
        serde_json::from_str::<PluginManifest>(json).expect("manifest parse failed")
    }

    #[test]
    fn primary_order_is_none_by_default() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview" }
              ]
            }
            "#,
        );
        assert_eq!(manifest.lines.len(), 1);
        assert!(manifest.lines[0].primary_order.is_none());
        assert!(manifest.links.is_empty());
    }

    #[test]
    fn primary_order_parsed_correctly() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview", "primaryOrder": 1 },
                { "type": "progress", "label": "B", "scope": "overview", "primaryOrder": 2 },
                { "type": "progress", "label": "C", "scope": "overview" }
              ]
            }
            "#,
        );

        assert_eq!(manifest.lines[0].primary_order, Some(1));
        assert_eq!(manifest.lines[1].primary_order, Some(2));
        assert!(manifest.lines[2].primary_order.is_none());
    }

    #[test]
    fn primary_candidates_sorted_by_order() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "Third", "scope": "overview", "primaryOrder": 3 },
                { "type": "progress", "label": "First", "scope": "overview", "primaryOrder": 1 },
                { "type": "progress", "label": "Second", "scope": "overview", "primaryOrder": 2 },
                { "type": "progress", "label": "None", "scope": "overview" }
              ]
            }
            "#,
        );

        // Extract candidates sorted by primary_order (same logic as lib.rs)
        let mut candidates: Vec<_> = manifest
            .lines
            .iter()
            .filter(|l| l.line_type == "progress" && l.primary_order.is_some())
            .collect();
        candidates.sort_by_key(|l| l.primary_order.unwrap());
        let labels: Vec<_> = candidates.iter().map(|l| l.label.as_str()).collect();

        assert_eq!(labels, vec!["First", "Second", "Third"]);
    }

    #[test]
    fn period_parsed_and_weekly_candidate_resolved() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "Session", "scope": "overview", "primaryOrder": 1 },
                { "type": "progress", "label": "Weekly", "scope": "overview", "period": "weekly" }
              ]
            }
            "#,
        );

        assert!(manifest.lines[0].period.is_none());
        assert_eq!(manifest.lines[1].period.as_deref(), Some("weekly"));

        // Exercise the shipped resolver used by list_plugins.
        assert_eq!(weekly_candidate(&manifest.lines), Some("Weekly"));
    }

    #[test]
    fn weekly_candidate_absent_when_no_period() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "Session", "scope": "overview", "primaryOrder": 1 }
              ]
            }
            "#,
        );

        assert_eq!(weekly_candidate(&manifest.lines), None);
    }

    #[test]
    fn weekly_candidate_first_match_wins() {
        // Precedence is intentionally first-match; lock it in so it can't drift silently.
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "Weekly A", "scope": "overview", "period": "weekly" },
                { "type": "progress", "label": "Weekly B", "scope": "overview", "period": "weekly" }
              ]
            }
            "#,
        );

        assert_eq!(weekly_candidate(&manifest.lines), Some("Weekly A"));
    }

    #[test]
    fn weekly_candidate_ignores_unsupported_period() {
        // A typo'd period (e.g. "week") is not recognized; the provider keeps its primary metric.
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "Weekly", "scope": "overview", "period": "week" }
              ]
            }
            "#,
        );

        assert_eq!(weekly_candidate(&manifest.lines), None);
    }

    #[test]
    fn links_are_parsed_when_present() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "links": [
                { "label": "Status", "url": "https://status.example.com" },
                { "label": "Billing", "url": "https://example.com/billing" }
              ],
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview", "primaryOrder": 1 }
              ]
            }
            "#,
        );

        assert_eq!(manifest.links.len(), 2);
        assert_eq!(manifest.links[0].label, "Status");
        assert_eq!(manifest.links[1].url, "https://example.com/billing");
    }

    #[test]
    fn sanitize_plugin_links_filters_invalid_entries() {
        let links = vec![
            PluginLink {
                label: " Status ".to_string(),
                url: " https://status.example.com ".to_string(),
            },
            PluginLink {
                label: " ".to_string(),
                url: "https://example.com".to_string(),
            },
            PluginLink {
                label: "Docs".to_string(),
                url: "ftp://example.com".to_string(),
            },
        ];

        let sanitized = sanitize_plugin_links("x", links);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].label, "Status");
        assert_eq!(sanitized[0].url, "https://status.example.com");
    }

    fn manifest_with_config(config_json: &str) -> PluginManifest {
        parse_manifest(&format!(
            r#"
            {{
              "schemaVersion": 1,
              "id": "test-plugin",
              "name": "Test",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "config": {config_json},
              "lines": [
                {{ "type": "progress", "label": "A", "scope": "overview" }}
              ]
            }}
            "#
        ))
    }

    #[test]
    fn plugin_config_field_default_source_defaults_false_and_parses_true() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                {
                  "id": "apiKey",
                  "type": "secret",
                  "label": "API Key",
                  "defaultSource": true
                },
                {
                  "id": "region",
                  "type": "select",
                  "label": "Region",
                  "options": [
                    { "value": "cn", "label": "CN" }
                  ]
                }
              ]
            }
            "#,
        );

        let fields = manifest.config.expect("config").fields;
        assert!(fields[0].default_source);
        assert!(!fields[1].default_source);
    }

    #[test]
    fn validate_plugin_config_accepts_well_formed_fields() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                {
                  "id": "apiKey",
                  "type": "secret",
                  "label": "API Key"
                },
                {
                  "id": "region",
                  "type": "select",
                  "label": "Region",
                  "options": [
                    { "value": "cn", "label": "CN" },
                    { "value": "global", "label": "Global" }
                  ]
                }
              ]
            }
            "#,
        );

        validate_plugin_config(&manifest).expect("valid config should pass");
    }

    #[test]
    fn validate_plugin_config_rejects_empty_field_id() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                { "id": "  ", "type": "text", "label": "Name" }
              ]
            }
            "#,
        );

        let error = validate_plugin_config(&manifest).expect_err("empty id should fail");
        assert!(error.to_string().contains("config field id cannot be empty"));
    }

    #[test]
    fn validate_plugin_config_rejects_duplicate_field_ids() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                { "id": "apiKey", "type": "secret", "label": "Primary" },
                { "id": "apiKey", "type": "secret", "label": "Duplicate" }
              ]
            }
            "#,
        );

        let error = validate_plugin_config(&manifest).expect_err("duplicate id should fail");
        assert!(error.to_string().contains("is duplicated"));
    }

    #[test]
    fn validate_plugin_config_rejects_empty_label() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                { "id": "apiKey", "type": "secret", "label": "  " }
              ]
            }
            "#,
        );

        let error = validate_plugin_config(&manifest).expect_err("empty label should fail");
        assert!(error.to_string().contains("label cannot be empty"));
    }

    #[test]
    fn validate_plugin_config_rejects_select_without_options() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                { "id": "region", "type": "select", "label": "Region", "options": [] }
              ]
            }
            "#,
        );

        let error = validate_plugin_config(&manifest).expect_err("empty options should fail");
        assert!(error.to_string().contains("needs options"));
    }

    #[test]
    fn validate_plugin_config_rejects_invalid_select_options() {
        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                {
                  "id": "region",
                  "type": "select",
                  "label": "Region",
                  "options": [
                    { "value": " ", "label": "Blank" },
                    { "value": "cn", "label": "CN" }
                  ]
                }
              ]
            }
            "#,
        );
        let empty_value = validate_plugin_config(&manifest).expect_err("empty option value");
        assert!(empty_value.to_string().contains("empty option value"));

        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                {
                  "id": "region",
                  "type": "select",
                  "label": "Region",
                  "options": [
                    { "value": "cn", "label": " " },
                    { "value": "global", "label": "Global" }
                  ]
                }
              ]
            }
            "#,
        );
        let empty_label = validate_plugin_config(&manifest).expect_err("empty option label");
        assert!(empty_label.to_string().contains("label cannot be empty"));

        let manifest = manifest_with_config(
            r#"
            {
              "fields": [
                {
                  "id": "region",
                  "type": "select",
                  "label": "Region",
                  "options": [
                    { "value": "cn", "label": "CN" },
                    { "value": "cn", "label": "Duplicate" }
                  ]
                }
              ]
            }
            "#,
        );
        let duplicate = validate_plugin_config(&manifest).expect_err("duplicate option");
        assert!(duplicate.to_string().contains("is duplicated"));
    }
}
