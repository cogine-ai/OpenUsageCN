use super::super::{host_api, manifest::LoadedPlugin};
use super::{DISCOVERY_TIMEOUT, MAX_FIELD_LENGTH, MAX_SECRET_FIELD_LENGTH};
use rquickjs::{Context, Object, Runtime, Value};
use std::path::Path;
use std::time::Instant;

pub(crate) struct ClaudeOAuthCredential(String);

impl ClaudeOAuthCredential {
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for ClaudeOAuthCredential {
    fn drop(&mut self) {
        unsafe { self.0.as_bytes_mut().fill(0) };
    }
}

pub(crate) fn claude_oauth_credential(
    plugin: &LoadedPlugin,
    app_data_dir: &Path,
    app_version: &str,
    connection_key: &str,
    credential_generation: &str,
) -> Result<ClaudeOAuthCredential, String> {
    if plugin.manifest.id != "claude"
        || connection_key.trim().is_empty()
        || connection_key.chars().count() > MAX_FIELD_LENGTH
        || !valid_generation(credential_generation)
    {
        return Err("Claude OAuth credential target is invalid".to_string());
    }
    let deadline_at = Instant::now()
        .checked_add(DISCOVERY_TIMEOUT)
        .unwrap_or_else(Instant::now);
    let deadline = host_api::ProbeDeadline::at(deadline_at);
    let runtime = Runtime::new().map_err(|_| credential_error())?;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline_at)));
    let context = Context::full(&runtime).map_err(|_| credential_error())?;
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
        .map_err(|_| credential_error())?;
        ctx.eval::<(), _>(plugin.entry_script.as_bytes())
            .map_err(|_| credential_error())?;

        let globals = ctx.globals();
        let plugin_object: Object = globals
            .get("__openusage_plugin")
            .map_err(|_| credential_error())?;
        let function: rquickjs::Function = plugin_object
            .get("oauthCredential")
            .map_err(|_| credential_error())?;
        let credential_context: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));
        let target = Object::new(ctx.clone()).map_err(|_| credential_error())?;
        target
            .set("connectionKey", connection_key)
            .and_then(|_| target.set("credentialGeneration", credential_generation))
            .map_err(|_| credential_error())?;
        let value: Value = function
            .call((credential_context, target))
            .map_err(|_| credential_error())?;
        if deadline.has_elapsed() {
            return Err("Claude OAuth credential extraction timed out".to_string());
        }
        let object = value.into_object().ok_or_else(credential_error)?;
        let mut access_token: String = object.get("accessToken").map_err(|_| credential_error())?;
        if access_token.is_empty()
            || access_token.len() > MAX_SECRET_FIELD_LENGTH
            || access_token.trim() != access_token
            || access_token.chars().any(char::is_control)
        {
            unsafe { access_token.as_bytes_mut().fill(0) };
            return Err(credential_error());
        }
        Ok(ClaudeOAuthCredential(access_token))
    })
}

fn valid_generation(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn credential_error() -> String {
    "Claude OAuth credential extraction failed".to_string()
}
