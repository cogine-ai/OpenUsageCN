use super::model::{AccountError, AccountProbe};
use crate::plugin_engine::{host_api, manifest::LoadedPlugin};
use rquickjs::{Context, Object, Runtime, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

pub(super) fn configuration(key: &str) -> HashMap<String, serde_json::Value> {
    HashMap::from([
        ("source".into(), serde_json::json!("apiKey")),
        ("apiKey".into(), serde_json::json!(key)),
    ])
}

pub(super) fn probe(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    key: &str,
) -> Result<AccountProbe, AccountError> {
    probe_with_deadline(
        plugin,
        dir,
        version,
        key,
        Instant::now() + Duration::from_secs(30),
        None,
    )
}

pub(super) fn probe_with_deadline(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    key: &str,
    deadline: Instant,
    expected_identity: Option<&str>,
) -> Result<AccountProbe, AccountError> {
    host_api::register_secret_for_redaction(key);
    let deadline = deadline.min(Instant::now() + Duration::from_secs(30));
    let error = || AccountError {
        code: "error".into(),
        message: "Could not load this Ollama account. Try again.".into(),
    };
    if Instant::now() >= deadline {
        return Err(error());
    }
    let runtime = Runtime::new().map_err(|_| error())?;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|_| error())?;
    let result = context.with(|ctx| {
        let fields = plugin
            .manifest
            .config
            .as_ref()
            .map(|c| c.fields.as_slice())
            .unwrap_or(&[]);
        host_api::inject_host_api_with_deadline(
            &ctx,
            "ollama",
            dir,
            version,
            fields,
            host_api::ProbeDeadline::at(deadline),
        )
        .map_err(|_| error())?;
        let mut configuration = configuration(key);
        if let Some(identity) = expected_identity {
            configuration.insert(
                "managedAccountFingerprint".into(),
                serde_json::json!(identity),
            );
        }
        host_api::override_configuration(&ctx, &configuration).map_err(|_| error())?;
        host_api::patch_http_wrapper(&ctx).map_err(|_| error())?;
        host_api::inject_utils(&ctx).map_err(|_| error())?;
        ctx.eval::<(), _>(plugin.entry_script.as_bytes())
            .map_err(|_| error())?;
        let globals = ctx.globals();
        let function: rquickjs::Function = globals
            .get("__openusage_ollama_account")
            .map_err(|_| error())?;
        let input: Value = globals.get("__openusage_ctx").map_err(|_| error())?;
        let result: Object = function.call((input,)).map_err(|_| {
            let thrown = ctx
                .catch()
                .as_string()
                .and_then(|s| s.to_string().ok())
                .unwrap_or_default();
            let code = serde_json::from_str::<AccountError>(&thrown)
                .ok()
                .map(|e| e.code)
                .unwrap_or_default();
            friendly_error(&code)
        })?;
        let stringify: rquickjs::Function = globals
            .get::<_, Object>("JSON")
            .and_then(|j| j.get("stringify"))
            .map_err(|_| error())?;
        let encoded: String = stringify.call((result,)).map_err(|_| error())?;
        if encoded.len() > 128 * 1024 {
            return Err(error());
        }
        let result: AccountProbe = serde_json::from_str(&encoded).map_err(|_| error())?;
        if result.identity.fingerprint.len() != 64
            || !result
                .identity
                .fingerprint
                .bytes()
                .all(|c| c.is_ascii_hexdigit())
            || result.lines.is_empty()
        {
            return Err(error());
        }
        Ok(result)
    });
    if result.is_err() {
        log::warn!("Ollama managed account probe failed safely");
    }
    result
}

pub(super) fn friendly_error(code: &str) -> AccountError {
    let (code, message) = match code {
        "authExpired" => ("authExpired", "Key 已失效或被拒绝，请检查或更新 Key。"),
        "permissionDenied" => ("permissionDenied", "此账号没有读取权限，请检查账号权限。"),
        "rateLimited" => ("rateLimited", "请求过于频繁，请稍后再试；上次数据已保留。"),
        "identityChanged" => (
            "identityChanged",
            "账号身份已变化，请重新验证 Key；原连接未被替换。",
        ),
        _ => ("error", "暂时无法读取此账号，请稍后重试；原连接未被替换。"),
    };
    AccountError {
        code: code.into(),
        message: message.into(),
    }
}
