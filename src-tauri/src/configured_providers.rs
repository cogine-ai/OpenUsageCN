//! Source snapshots for configurable providers and Kiro, shared by GUI and CLI.
use crate::plugin_engine::{
    host_api,
    manifest::LoadedPlugin,
    runtime::{self, PluginOutput},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

pub(crate) fn config_fields(
    id: &str,
) -> Result<Vec<crate::plugin_engine::manifest::PluginConfigField>, String> {
    let raw = match id {
        "claude-platform" => include_str!("../../plugins/claude-platform/plugin.json"),
        "workbuddy" => include_str!("../../plugins/workbuddy/plugin.json"),
        "trae-cn" => include_str!("../../plugins/trae-cn/plugin.json"),
        "litellm" => include_str!("../../plugins/litellm/plugin.json"),
        "siliconflow" => include_str!("../../plugins/siliconflow/plugin.json"),
        "muse" => include_str!("../../plugins/muse/plugin.json"),
        "kiro" => include_str!("../../plugins/kiro/plugin.json"),
        _ => return Err("连接来源配置不受支持。".into()),
    };
    let manifest: crate::plugin_engine::manifest::PluginManifest =
        serde_json::from_str(raw).map_err(|_| "连接来源配置不受支持。")?;
    Ok(manifest
        .config
        .map(|config| config.fields)
        .unwrap_or_default())
}

pub(crate) fn required_environment<'a>(
    fields: &'a [crate::plugin_engine::manifest::PluginConfigField],
    values: &HashMap<String, Value>,
) -> Vec<&'a str> {
    fields
        .iter()
        .filter(|field| {
            let value = values
                .get(&field.id)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            value.is_empty() || field.auto_value.as_deref() == Some(value)
        })
        .flat_map(|field| field.environment_variables.iter().map(String::as_str))
        .collect()
}

pub(crate) fn supports(id: &str) -> bool {
    matches!(
        id,
        "claude-platform" | "workbuddy" | "trae-cn" | "litellm" | "siliconflow" | "muse" | "kiro"
    )
}

pub(crate) struct Probe {
    plugin: LoadedPlugin,
    pub output: PluginOutput,
    pub started_at: time::OffsetDateTime,
    preparation_error: Option<String>,
    fingerprint: String,
    values: HashMap<String, Value>,
    environment: HashMap<String, Option<String>>,
    deadline: Instant,
}
fn environment(
    plugin: &LoadedPlugin,
    values: &HashMap<String, Value>,
    deadline: Instant,
) -> Result<HashMap<String, Option<String>>, String> {
    let fields = plugin
        .manifest
        .config
        .as_ref()
        .map(|c| c.fields.as_slice())
        .unwrap_or_default();
    let names = required_environment(fields, values);
    if names
        .iter()
        .any(|n| !host_api::is_env_var_allowed_for_plugin(&plugin.manifest.id, n))
    {
        return Err("连接来源配置不受支持。".into());
    }
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let resolved = host_api::resolve_env_values_before(&names, deadline);
    if !resolved.unresolved.is_empty() {
        return Err("无法确认环境中的连接来源，请重试。".into());
    }
    for (name, value) in &resolved.values {
        if !host_api::is_public_config_env(name) {
            if let Some(value) = value {
                host_api::register_secret_for_redaction(value);
            }
        }
    }
    Ok(resolved.values)
}
impl Probe {
    pub(crate) fn run(plugin: &LoadedPlugin, dir: &PathBuf, version: &str) -> Self {
        let deadline = Instant::now() + Duration::from_secs(30);
        let started_at = time::OffsetDateTime::now_utc();
        let fields = plugin
            .manifest
            .config
            .as_ref()
            .map(|c| c.fields.as_slice())
            .unwrap_or_default();
        let prepared = (|| {
            if plugin.manifest.id == "kiro" {
                let source = crate::kiro_sources::snapshot()?;
                return Ok((HashMap::new(), source.environment, source.fingerprint));
            }
            let values =
                crate::provider_config::resolved_values_from_disk(&plugin.manifest.id, fields)?;
            let environment = environment(plugin, &values, deadline)?;
            Ok::<_, String>((
                values,
                environment,
                crate::provider_config::configuration_fingerprint(&plugin.manifest.id)?,
            ))
        })();
        match prepared {
            Ok((values, environment, fingerprint)) => {
                let output = runtime::run_probe_with_sources(
                    plugin,
                    dir,
                    version,
                    &values,
                    &environment,
                    deadline,
                );
                Self {
                    plugin: plugin.clone(),
                    output,
                    started_at,
                    values,
                    environment,
                    fingerprint,
                    deadline,
                    preparation_error: None,
                }
            }
            Err(error) => Self {
                plugin: plugin.clone(),
                output: runtime::provider_account_probe_error(plugin, &error),
                preparation_error: Some(error),
                fingerprint: String::new(),
                started_at,
                values: HashMap::new(),
                environment: HashMap::new(),
                deadline,
            },
        }
    }
    pub(crate) fn publish<T>(
        &self,
        commit: impl FnOnce(&PluginOutput, time::OffsetDateTime) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(error) = &self.preparation_error {
            return Err(error.clone());
        }
        if Instant::now() >= self.deadline {
            return Err("用量读取超时，请重试。".into());
        }
        if self.plugin.manifest.id == "kiro" {
            let source = crate::kiro_sources::snapshot()?;
            if source.fingerprint != self.fingerprint || source.environment != self.environment {
                return Err("Kiro connection changed. Refresh usage.".into());
            }
        } else if environment(&self.plugin, &self.values, self.deadline)? != self.environment {
            return Err("连接来源已更改，请重新刷新。".into());
        }
        let fields = self
            .plugin
            .manifest
            .config
            .as_ref()
            .map(|c| c.fields.as_slice())
            .unwrap_or_default();
        crate::provider_config::with_configuration_guard(
            &self.plugin.manifest.id,
            fields,
            &self.values,
            || {
                if runtime::probe_error_message(&self.output).is_none() {
                    crate::local_http_api::cache::cache_configured_output(
                        &self.output,
                        self.started_at,
                        &self.fingerprint,
                    )?;
                }
                commit(&self.output, self.started_at)
            },
        )
    }
}

#[cfg(test)]
#[path = "configured_providers_tests.rs"]
mod tests;

/// Preserve same-source stale values, but never show a previous Kiro login after failure.
pub(crate) fn invalidate_failed_output(output: &PluginOutput) -> bool {
    output.provider_id == "kiro"
        && runtime::probe_error_message(output).is_some()
        && crate::local_http_api::cache::snapshot_for_provider("kiro").is_none()
}

#[cfg(test)]
#[path = "configured_provider_kiro_tests.rs"]
mod kiro_tests;
