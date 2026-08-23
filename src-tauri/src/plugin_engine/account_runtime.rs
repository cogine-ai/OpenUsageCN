use super::{host_api, manifest::LoadedPlugin};
use rquickjs::{Array, Context, Object, Runtime, Value};
use std::path::Path;
use std::time::{Duration, Instant};

mod claude_credential;

pub(crate) use claude_credential::claude_oauth_credential;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DISCOVERY_ITEMS: usize = 16;
const MAX_FIELD_LENGTH: usize = 512;
const MAX_SECRET_FIELD_LENGTH: usize = 64 * 1024;

pub(crate) struct HistoryCredential(String);

impl HistoryCredential {
    #[cfg(test)]
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for HistoryCredential {
    fn drop(&mut self) {
        unsafe { self.0.as_bytes_mut().fill(0) };
    }
}

pub(crate) struct AccountDiscoveryClaim {
    pub identity_namespace: String,
    pub identity: AccountDiscoveryIdentity,
    pub connection_key: String,
    pub connection_kind: String,
}

pub(crate) enum AccountDiscoveryIdentity {
    Normalized(String),
    ClaudeOAuthProfile,
}

pub(crate) struct AccountSourceOutcome {
    pub source_key: String,
    pub status: String,
}

pub(crate) struct AccountDiscoveryResult {
    pub observations: Vec<AccountDiscoveryClaim>,
    pub source_outcomes: Vec<AccountSourceOutcome>,
    pub default_connection_key: Option<String>,
}

pub(crate) fn credential_generation(
    plugin: &LoadedPlugin,
    app_data_dir: &Path,
    app_version: &str,
    connection_key: &str,
) -> Result<String, String> {
    if connection_key.trim().is_empty() || connection_key.chars().count() > MAX_FIELD_LENGTH {
        return Err("account credential target is invalid".to_string());
    }
    let deadline_at = Instant::now()
        .checked_add(DISCOVERY_TIMEOUT)
        .unwrap_or_else(Instant::now);
    let deadline = host_api::ProbeDeadline::at(deadline_at);
    let runtime = Runtime::new().map_err(|_| "account credential runtime failed".to_string())?;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline_at)));
    let context =
        Context::full(&runtime).map_err(|_| "account credential runtime failed".to_string())?;
    let app_data_dir = app_data_dir.to_path_buf();

    context.with(|ctx| {
        let config_fields = plugin
            .manifest
            .config
            .as_ref()
            .map(|config| config.fields.as_slice())
            .unwrap_or(&[]);
        host_api::inject_host_api_with_deadline(
            &ctx,
            &plugin.manifest.id,
            &app_data_dir,
            app_version,
            config_fields,
            deadline,
        )
        .map_err(|_| "account credential host setup failed".to_string())?;
        host_api::patch_http_wrapper(&ctx)
            .map_err(|_| "account credential host setup failed".to_string())?;
        host_api::patch_ls_wrapper(&ctx)
            .map_err(|_| "account credential host setup failed".to_string())?;
        host_api::patch_ccusage_wrapper(&ctx)
            .map_err(|_| "account credential host setup failed".to_string())?;
        host_api::inject_utils(&ctx)
            .map_err(|_| "account credential host setup failed".to_string())?;
        ctx.eval::<(), _>(plugin.entry_script.as_bytes())
            .map_err(|_| "account credential script failed".to_string())?;

        let globals = ctx.globals();
        let plugin_object: Object = globals
            .get("__openusage_plugin")
            .map_err(|_| "account credential export is missing".to_string())?;
        let generation_function: rquickjs::Function = plugin_object
            .get("credentialGeneration")
            .map_err(|_| "account credential export is missing".to_string())?;
        let credential_context: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));
        let target = Object::new(ctx.clone())
            .map_err(|_| "account credential target could not be created".to_string())?;
        target
            .set("connectionKey", connection_key)
            .map_err(|_| "account credential target could not be created".to_string())?;
        let generation: String = generation_function
            .call((credential_context, target))
            .map_err(|_| "account credential generation failed".to_string())?;
        if deadline.has_elapsed() {
            return Err("account credential generation timed out".to_string());
        }
        let generation = generation.trim().to_string();
        if generation.len() != 64
            || !generation
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("account credential generation is invalid".to_string());
        }
        Ok(generation)
    })
}

pub(crate) fn history_credential(
    plugin: &LoadedPlugin,
    app_data_dir: &Path,
    app_version: &str,
    connection_key: &str,
    credential_generation: &str,
) -> Result<HistoryCredential, String> {
    if connection_key.trim().is_empty()
        || connection_key.chars().count() > MAX_FIELD_LENGTH
        || credential_generation.len() != 64
        || !credential_generation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("account history credential target is invalid".to_string());
    }
    let deadline_at = Instant::now()
        .checked_add(DISCOVERY_TIMEOUT)
        .unwrap_or_else(Instant::now);
    let deadline = host_api::ProbeDeadline::at(deadline_at);
    let runtime = Runtime::new().map_err(|_| "account history runtime failed".to_string())?;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline_at)));
    let context =
        Context::full(&runtime).map_err(|_| "account history runtime failed".to_string())?;
    let app_data_dir = app_data_dir.to_path_buf();

    context.with(|ctx| {
        let config_fields = plugin
            .manifest
            .config
            .as_ref()
            .map(|config| config.fields.as_slice())
            .unwrap_or(&[]);
        host_api::inject_host_api_with_deadline(
            &ctx,
            &plugin.manifest.id,
            &app_data_dir,
            app_version,
            config_fields,
            deadline,
        )
        .map_err(|_| "account history host setup failed".to_string())?;
        host_api::patch_http_wrapper(&ctx)
            .map_err(|_| "account history host setup failed".to_string())?;
        host_api::patch_ls_wrapper(&ctx)
            .map_err(|_| "account history host setup failed".to_string())?;
        host_api::patch_ccusage_wrapper(&ctx)
            .map_err(|_| "account history host setup failed".to_string())?;
        host_api::inject_utils(&ctx)
            .map_err(|_| "account history host setup failed".to_string())?;
        ctx.eval::<(), _>(plugin.entry_script.as_bytes())
            .map_err(|_| "account history script failed".to_string())?;

        let globals = ctx.globals();
        let plugin_object: Object = globals
            .get("__openusage_plugin")
            .map_err(|_| "account history export is missing".to_string())?;
        let credential_function: rquickjs::Function = plugin_object
            .get("historyCredential")
            .map_err(|_| "account history export is missing".to_string())?;
        let credential_context: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));
        let target = Object::new(ctx.clone())
            .map_err(|_| "account history target could not be created".to_string())?;
        target
            .set("connectionKey", connection_key)
            .and_then(|_| target.set("credentialGeneration", credential_generation))
            .map_err(|_| "account history target could not be created".to_string())?;
        let value: Value = credential_function
            .call((credential_context, target))
            .map_err(|_| "account history credential extraction failed".to_string())?;
        if deadline.has_elapsed() {
            return Err("account history credential extraction timed out".to_string());
        }
        let object = value
            .into_object()
            .ok_or_else(|| "account history credential is invalid".to_string())?;
        let cookie_header: String = object
            .get("cookieHeader")
            .map_err(|_| "account history credential is invalid".to_string())?;
        if cookie_header.is_empty()
            || cookie_header.len() > MAX_SECRET_FIELD_LENGTH
            || cookie_header.trim() != cookie_header
            || cookie_header.chars().any(char::is_control)
        {
            return Err("account history credential is invalid".to_string());
        }
        Ok(HistoryCredential(cookie_header))
    })
}

pub(crate) fn discover_connections(
    plugin: &LoadedPlugin,
    app_data_dir: &Path,
    app_version: &str,
) -> Result<AccountDiscoveryResult, String> {
    let deadline_at = Instant::now()
        .checked_add(DISCOVERY_TIMEOUT)
        .unwrap_or_else(Instant::now);
    let deadline = host_api::ProbeDeadline::at(deadline_at);
    let runtime = Runtime::new().map_err(|_| "account discovery runtime failed".to_string())?;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline_at)));
    let context =
        Context::full(&runtime).map_err(|_| "account discovery runtime failed".to_string())?;
    let app_data_dir = app_data_dir.to_path_buf();

    context.with(|ctx| {
        let config_fields = plugin
            .manifest
            .config
            .as_ref()
            .map(|config| config.fields.as_slice())
            .unwrap_or(&[]);
        host_api::inject_host_api_with_deadline(
            &ctx,
            &plugin.manifest.id,
            &app_data_dir,
            app_version,
            config_fields,
            deadline,
        )
        .map_err(|_| "account discovery host setup failed".to_string())?;
        host_api::patch_http_wrapper(&ctx)
            .map_err(|_| "account discovery host setup failed".to_string())?;
        host_api::patch_ls_wrapper(&ctx)
            .map_err(|_| "account discovery host setup failed".to_string())?;
        host_api::patch_ccusage_wrapper(&ctx)
            .map_err(|_| "account discovery host setup failed".to_string())?;
        host_api::inject_utils(&ctx)
            .map_err(|_| "account discovery host setup failed".to_string())?;
        ctx.eval::<(), _>(plugin.entry_script.as_bytes())
            .map_err(|_| discovery_script_error(deadline))?;

        let globals = ctx.globals();
        let plugin_object: Object = globals
            .get("__openusage_plugin")
            .map_err(|_| "account discovery export is missing".to_string())?;
        let discovery_function: rquickjs::Function = plugin_object
            .get("discoverConnections")
            .map_err(|_| "account discovery export is missing".to_string())?;
        let discovery_context: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));
        let result_value: Value = discovery_function
            .call((discovery_context,))
            .map_err(|_| discovery_script_error(deadline))?;
        if deadline.has_elapsed() {
            return Err("account discovery timed out".to_string());
        }
        let result = result_value
            .into_object()
            .ok_or_else(|| "account discovery returned an invalid result".to_string())?;
        parse_discovery_result(&plugin.manifest.id, &result)
    })
}

fn discovery_script_error(deadline: host_api::ProbeDeadline) -> String {
    if deadline.has_elapsed() {
        "account discovery timed out"
    } else {
        "account discovery script failed"
    }
    .to_string()
}

fn parse_discovery_result(
    provider_id: &str,
    result: &Object<'_>,
) -> Result<AccountDiscoveryResult, String> {
    let observations: Array = result
        .get("observations")
        .map_err(|_| "account discovery observations are missing".to_string())?;
    let source_outcomes: Array = result
        .get("sourceOutcomes")
        .map_err(|_| "account discovery source outcomes are missing".to_string())?;
    if observations.len() > MAX_DISCOVERY_ITEMS || source_outcomes.len() > MAX_DISCOVERY_ITEMS {
        return Err("account discovery returned too many items".to_string());
    }

    let mut parsed_observations = Vec::with_capacity(observations.len());
    for index in 0..observations.len() {
        let item: Object = observations
            .get(index)
            .map_err(|_| "account discovery returned an invalid observation".to_string())?;
        let identity_source = item.get::<_, String>("identitySource").ok();
        let identity = match identity_source.as_deref() {
            Some("claudeOAuthProfile") if provider_id == "claude" => {
                AccountDiscoveryIdentity::ClaudeOAuthProfile
            }
            Some(_) => return Err("account discovery returned an invalid identity source".into()),
            None => {
                AccountDiscoveryIdentity::Normalized(required_string(&item, "normalizedIdentity")?)
            }
        };
        parsed_observations.push(AccountDiscoveryClaim {
            identity_namespace: required_string(&item, "identityNamespace")?,
            identity,
            connection_key: required_string(&item, "connectionKey")?,
            connection_kind: required_string(&item, "connectionKind")?,
        });
    }

    let mut parsed_outcomes = Vec::with_capacity(source_outcomes.len());
    for index in 0..source_outcomes.len() {
        let item: Object = source_outcomes
            .get(index)
            .map_err(|_| "account discovery returned an invalid source outcome".to_string())?;
        parsed_outcomes.push(AccountSourceOutcome {
            source_key: required_string(&item, "sourceKey")?,
            status: required_string(&item, "status")?,
        });
    }

    let default_connection_key = result
        .get::<_, Value>("defaultConnectionKey")
        .ok()
        .and_then(|value| value.as_string().cloned())
        .and_then(|value| value.to_string().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if default_connection_key
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_FIELD_LENGTH)
    {
        return Err("account discovery returned an invalid default connection".to_string());
    }

    Ok(AccountDiscoveryResult {
        observations: parsed_observations,
        source_outcomes: parsed_outcomes,
        default_connection_key,
    })
}

fn required_string(object: &Object<'_>, field: &str) -> Result<String, String> {
    let value = object
        .get::<_, String>(field)
        .map_err(|_| "account discovery returned an invalid field".to_string())?;
    let value = value.trim().to_string();
    let length = value.chars().count();
    if length == 0 || length > MAX_FIELD_LENGTH || value.chars().any(char::is_control) {
        return Err("account discovery returned an invalid field".to_string());
    }
    Ok(value)
}

#[cfg(test)]
#[path = "account_runtime_tests.rs"]
mod tests;
