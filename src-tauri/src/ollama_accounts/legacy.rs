use super::{
    Primary,
    model::{AccountError, LegacyRecord},
    store,
};
use crate::plugin_engine::{
    host_api,
    manifest::LoadedPlugin,
    runtime::{PluginOutput, probe_error_message},
};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    time::{Duration, Instant},
};

const LOCK_ID: &str = "original-connection";

pub(super) struct Configuration {
    pub values: HashMap<String, serde_json::Value>,
    pub source: String,
    pub configured: bool,
    pub generation: String,
    pub error: Option<AccountError>,
    stored_generation: String,
}

#[cfg(test)]
thread_local! {
    pub(super) static TEST_ENV: std::cell::RefCell<Option<(HashMap<String, Option<String>>, std::collections::HashSet<String>)>> = const { std::cell::RefCell::new(None) };
    pub(super) static TEST_CONFIGURATION: std::cell::RefCell<Option<HashMap<String, serde_json::Value>>> = const { std::cell::RefCell::new(None) };
    pub(super) static BEFORE_COMMIT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    pub(super) static BEFORE_LOCK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    pub(super) static AFTER_CONFIGURATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn configuration(plugin: &LoadedPlugin) -> Configuration {
    configuration_before(plugin, Instant::now() + Duration::from_secs(5))
}

fn stored_generation(plugin: &LoadedPlugin) -> String {
    stored_generation_for(&stored_values(plugin))
}

fn stored_generation_for(values: &Result<HashMap<String, serde_json::Value>, String>) -> String {
    let sorted = values
        .as_ref()
        .ok()
        .map(|values| values.iter().collect::<BTreeMap<_, _>>());
    crate::safe_file::sha256_hex(serde_json::json!(sorted).to_string().as_bytes())
}

fn stored_values(plugin: &LoadedPlugin) -> Result<HashMap<String, serde_json::Value>, String> {
    #[cfg(test)]
    if let Some(values) = TEST_CONFIGURATION.with(|value| value.borrow().clone()) {
        return Ok(values);
    }
    let fields = plugin
        .manifest
        .config
        .as_ref()
        .map(|c| c.fields.as_slice())
        .unwrap_or(&[]);
    crate::provider_config::resolved_values_from_disk("ollama", fields)
}

pub(super) fn still_current(plugin: &LoadedPlugin, configuration: &Configuration) -> bool {
    stored_generation(plugin) == configuration.stored_generation
}

pub(super) fn configuration_before(plugin: &LoadedPlugin, deadline: Instant) -> Configuration {
    let fields = plugin
        .manifest
        .config
        .as_ref()
        .map(|c| c.fields.as_slice())
        .unwrap_or(&[]);
    let result = stored_values(plugin);
    let stored_generation = stored_generation_for(&result);
    let mut values = match result {
        Ok(values) => values,
        Err(_) => {
            log::error!("Ollama original connection settings could not be read");
            return Configuration {
                values: HashMap::new(),
                source: "cookie".into(),
                configured: false,
                generation: stored_generation.clone(),
                stored_generation,
                error: Some(AccountError {
                    code: "configurationUnavailable".into(),
                    message: "无法读取原连接设置，请检查配置文件后重试。".into(),
                }),
            };
        }
    };
    let source = values
        .get("source")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("cookie")
        .to_string();
    let (field, environment) = if source == "apiKey" {
        ("apiKey", "OLLAMA_API_KEY")
    } else {
        ("cookieHeader", "OLLAMA_CLOUD_COOKIE")
    };
    let stored = values
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty());
    let mut unavailable = false;
    if stored.is_none()
        && fields.iter().any(|f| {
            f.id == field
                && f.environment_variables
                    .iter()
                    .any(|name| name == environment)
        })
    {
        #[cfg(test)]
        let test_env = TEST_ENV.with(|value| value.borrow().clone());
        #[cfg(not(test))]
        let test_env: Option<(
            HashMap<String, Option<String>>,
            std::collections::HashSet<String>,
        )> = None;
        let (resolved, unresolved) = test_env.unwrap_or_else(|| {
            let env = host_api::resolve_env_values_before(&[environment], deadline);
            (env.values, env.unresolved)
        });
        unavailable = unresolved.contains(environment);
        if let Some(key) = resolved
            .get(environment)
            .and_then(Option::as_deref)
            .filter(|s| !s.is_empty())
        {
            host_api::register_secret_for_redaction(key);
            values.insert(field.into(), serde_json::json!(key));
        }
    }
    let configured = values
        .get(field)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| !s.is_empty());
    // Only the selected source influences this connection. Unused credentials are not copied.
    values.retain(|key, _| key == "source" || key == field);
    values.insert("source".into(), serde_json::json!(source));
    let sorted: BTreeMap<_, _> = values.iter().collect();
    let generation = crate::safe_file::sha256_hex(
        serde_json::json!([sorted, unavailable])
            .to_string()
            .as_bytes(),
    );
    let error = unavailable.then(|| {
        log::error!("Ollama original connection environment could not be confirmed");
        AccountError {
            code: "configurationUnavailable".into(),
            message: "无法确认原连接的环境变量配置，请检查终端设置后重试。".into(),
        }
    });
    let captured = Configuration {
        values,
        source,
        configured,
        generation,
        error,
        stored_generation,
    };
    #[cfg(test)]
    if let Some(hook) = AFTER_CONFIGURATION.with(|value| value.borrow_mut().take()) {
        hook();
    }
    captured
}

pub(super) fn synchronize(plugin: &LoadedPlugin, deadline: Instant) -> Result<(), String> {
    let configuration = configuration_before(plugin, deadline);
    let _guard = store::lock_until(deadline)?;
    let mut stored = store::read()?;
    if stored_generation(plugin) != configuration.stored_generation {
        return Err(store::changed());
    }
    synchronize_locked(&mut stored, &configuration, deadline)?;
    Ok(())
}

fn synchronize_locked(
    stored: &mut super::model::StoredAccounts,
    configuration: &Configuration,
    deadline: Instant,
) -> Result<(), String> {
    if stored.legacy.configuration_generation.as_deref() != Some(&configuration.generation) {
        let revision = stored
            .legacy
            .revision
            .checked_add(1)
            .ok_or_else(store::changed)?;
        stored.legacy = LegacyRecord {
            revision,
            source: configuration.source.clone(),
            configured: configuration.configured,
            configuration_generation: Some(configuration.generation.clone()),
            error: configuration.error.clone(),
            ..LegacyRecord::default()
        };
        store::write_before(stored, stored.primary == Primary::Legacy, Some(deadline))?;
    }
    Ok(())
}

pub(super) fn refresh(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    deadline: Instant,
) -> Result<PluginOutput, String> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(30));
    let queued_revision = {
        let _guard = store::lock_until(deadline)?;
        store::read()?.legacy.revision
    };
    #[cfg(test)]
    if let Some(hook) = BEFORE_LOCK.with(|value| value.borrow_mut().take()) {
        hook();
    }
    let _connection = store::acquire_refresh(LOCK_ID, deadline)?;
    let configuration = configuration_before(plugin, deadline);
    let revision = {
        let _guard = store::lock_until(deadline)?;
        let mut stored = store::read()?;
        if stored.legacy.revision != queued_revision {
            return Err(store::changed());
        }
        if stored_generation(plugin) != configuration.stored_generation {
            return Err(store::changed());
        }
        synchronize_locked(&mut stored, &configuration, deadline)?;
        if let Some(error) = configuration.error.as_ref() {
            return Err(error.message.clone());
        }
        if !configuration.configured {
            return Err("原连接尚未配置，请添加所选来源的 Cookie 或 API Key。".into());
        }
        stored.legacy.revision
    };
    let result = crate::plugin_engine::runtime::run_probe_with_configuration(
        plugin,
        dir,
        version,
        &configuration.values,
        deadline,
    );
    #[cfg(test)]
    if let Some(hook) = BEFORE_COMMIT.with(|value| value.borrow_mut().take()) {
        hook();
    }
    // Resolve again before taking the mutation lock; a settings writer never waits for shell I/O.
    let current_configuration = configuration_before(plugin, deadline);
    let _guard = store::lock_until(deadline)?;
    let mut stored = store::read()?;
    if stored.legacy.revision != revision
        || current_configuration.generation != configuration.generation
        || stored_generation(plugin) != current_configuration.stored_generation
    {
        if still_current(plugin, &current_configuration) {
            synchronize_locked(&mut stored, &current_configuration, deadline)?;
        }
        return Err(store::changed());
    }
    if let Some(message) = probe_error_message(&result) {
        log::warn!("Ollama original connection quota refresh failed");
        let expired = matches!(
            message,
            "Ollama API key expired or was rejected. Check Settings."
                | "Ollama Cloud session expired. Sign in at ollama.com and copy a fresh Cookie header."
        );
        if expired {
            stored.legacy.snapshot = None;
            stored.legacy.last_updated_at = None;
        }
        stored.legacy.error = Some(AccountError {
            code: if expired { "authExpired" } else { "error" }.into(),
            message: message.into(),
        });
    } else {
        stored.legacy.snapshot = Some(result.clone());
        stored.legacy.last_updated_at = Some(super::now());
        stored.legacy.error = None;
    }
    let clear_primary = stored.primary == Primary::Legacy && stored.legacy.snapshot.is_none();
    store::write_before(&mut stored, clear_primary, Some(deadline))?;
    if stored.primary == Primary::Legacy {
        super::publish_cached_primary(&stored, deadline)?;
    }
    Ok(result)
}

pub(super) fn current_output(
    plugin: &LoadedPlugin,
    stored: &super::model::StoredAccounts,
) -> PluginOutput {
    if let Some(error) = stored.legacy.error.as_ref() {
        return crate::plugin_engine::runtime::provider_account_probe_error(plugin, &error.message);
    }
    stored.legacy.snapshot.clone().unwrap_or_else(|| {
        crate::plugin_engine::runtime::provider_account_probe_error(
            plugin,
            "原连接尚未读取用量，请检查配置后刷新。",
        )
    })
}
