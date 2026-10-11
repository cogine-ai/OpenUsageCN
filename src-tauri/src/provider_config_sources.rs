use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::{PluginConfigField, PluginConfigFieldType};
use crate::provider_config::{ProviderConfigEnvironment, ProviderConfigView};
use std::collections::{HashMap, HashSet};

pub fn view_for_plugin(
    plugin_id: &str,
    fields: &[PluginConfigField],
) -> Result<ProviderConfigView, String> {
    let view = crate::provider_config::view_for_plugin(plugin_id, fields);
    let names = environment_names(plugin_id, fields)?;
    if names.is_empty() {
        return Ok(view);
    }
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let resolved = host_api::resolve_env_values(&names);
    Ok(with_environment(view, plugin_id, fields, &resolved))
}

fn with_environment(
    mut view: ProviderConfigView,
    plugin_id: &str,
    fields: &[PluginConfigField],
    resolved: &host_api::ResolvedEnvValues,
) -> ProviderConfigView {
    decorate(&mut view, plugin_id, fields, &resolved.values);
    // A failed region lookup cannot establish which Moonshot key is active.
    if plugin_id == "moonshot" && resolved.unresolved.contains("MOONSHOT_REGION") {
        for field in ["apiKeyIntl", "apiKeyCn"] {
            view.environment.remove(field);
        }
    }
    if !resolved.unresolved.is_empty() {
        log::error!(
            "Unable to confirm provider environment sources for {plugin_id}: {:?}",
            resolved.unresolved
        );
        view.environment_error = Some("无法确认环境变量配置，请检查终端设置后重试。".into());
        view.environment_unresolved = resolved.unresolved.iter().cloned().collect();
        view.environment_unresolved.sort();
    }
    view
}

fn environment_names(plugin_id: &str, fields: &[PluginConfigField]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for name in fields.iter().flat_map(|field| &field.environment_variables) {
        if !host_api::is_env_var_allowed_for_plugin(plugin_id, name) {
            log::error!("Rejected undeclared provider environment source {plugin_id}: {name}");
            return Err("服务商环境变量配置不受支持。".into());
        }
        if seen.insert(name.clone()) {
            names.push(name.clone());
        }
    }
    Ok(names)
}

fn decorate(
    view: &mut ProviderConfigView,
    plugin_id: &str,
    fields: &[PluginConfigField],
    env: &HashMap<String, Option<String>>,
) {
    // Register every inspected secret, including lower-priority or inactive sources.
    for (name, value) in env {
        if !host_api::is_public_config_env(name) {
            if let Some(value) = value {
                host_api::register_secret_for_redaction(value);
            }
        }
    }
    for field in fields {
        if plugin_id == "moonshot" && matches!(field.id.as_str(), "apiKeyIntl" | "apiKeyCn") {
            let region = env
                .get("MOONSHOT_REGION")
                .and_then(Option::as_deref)
                .filter(|value| !value.is_empty())
                .unwrap_or("international");
            let expected = if field.id == "apiKeyCn" {
                "china"
            } else {
                "international"
            };
            if region != expected {
                continue;
            }
        }
        let configured = field.environment_variables.iter().find_map(|name| {
            env.get(name)
                .and_then(Option::as_deref)
                .filter(|value| !value.is_empty())
                .map(|value| (name, value))
        });
        let Some((name, value)) = configured else {
            continue;
        };
        let public_value = field.field_type == PluginConfigFieldType::Select
            && host_api::is_public_config_env(name)
            && field.auto_value.as_deref() != Some(value)
            && field.options.iter().any(|option| option.value == value);
        view.environment.insert(
            field.id.clone(),
            ProviderConfigEnvironment {
                name: name.clone(),
                configured: true,
                value: public_value.then(|| value.to_string()),
            },
        );
    }
}

#[cfg(test)]
#[path = "provider_config_sources_tests.rs"]
mod tests;
