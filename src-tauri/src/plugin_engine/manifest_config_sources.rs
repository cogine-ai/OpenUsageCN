use super::{PluginConfigField, PluginConfigFieldType};
use crate::plugin_engine::host_api;
use std::collections::HashSet;

/// Rejects invalid requirements, selector defaults, visibility cycles, and unsafe environment names.
pub(super) fn validate_config_sources(
    plugin_id: &str,
    fields: &[PluginConfigField],
) -> Result<(), String> {
    for field in fields {
        if field.required
            && !matches!(
                field.field_type,
                PluginConfigFieldType::Secret | PluginConfigFieldType::Text
            )
        {
            return Err(format!(
                "plugin {plugin_id} field '{}' required is supported only for secret or text fields",
                field.id
            ));
        }
        if let Some(value) = &field.auto_value {
            if field.field_type != PluginConfigFieldType::Select
                || !field.options.iter().any(|option| &option.value == value)
            {
                return Err(format!(
                    "plugin {plugin_id} field '{}' autoValue must be a select option",
                    field.id
                ));
            }
        }
        if let Some(visible) = &field.visible_when {
            let dependency = fields.iter().find(|entry| entry.id == visible.field);
            let Some(dependency) = dependency.filter(|entry| {
                entry.id != field.id && entry.field_type == PluginConfigFieldType::Select
            }) else {
                return Err(format!(
                    "plugin {plugin_id} field '{}' visibleWhen must reference another select field",
                    field.id
                ));
            };
            let mut seen = HashSet::new();
            if visible.values.is_empty()
                || visible.values.iter().any(|value| {
                    !seen.insert(value)
                        || !dependency
                            .options
                            .iter()
                            .any(|option| &option.value == value)
                })
            {
                return Err(format!(
                    "plugin {plugin_id} field '{}' visibleWhen needs distinct dependency options",
                    field.id
                ));
            }
        }
        let mut seen = HashSet::new();
        for name in &field.environment_variables {
            if !seen.insert(name) || !host_api::is_env_var_allowed_for_plugin(plugin_id, name) {
                return Err(format!(
                    "plugin {plugin_id} field '{}' environmentVariables must be distinct allowed names",
                    field.id
                ));
            }
            if field.field_type == PluginConfigFieldType::Select
                && !host_api::is_public_config_env(name)
            {
                return Err(format!(
                    "plugin {plugin_id} field '{}' cannot expose a secret environment variable as a select",
                    field.id
                ));
            }
        }
    }
    for field in fields {
        let mut seen = HashSet::new();
        let mut current = field;
        while let Some(visible) = &current.visible_when {
            if !seen.insert(&current.id) {
                return Err(format!(
                    "plugin {plugin_id} config visibility dependencies form a cycle"
                ));
            }
            current = fields
                .iter()
                .find(|entry| entry.id == visible.field)
                .expect("visibility dependency was validated");
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "manifest_config_sources_tests.rs"]
mod tests;
