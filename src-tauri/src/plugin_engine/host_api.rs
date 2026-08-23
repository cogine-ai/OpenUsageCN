use crate::plugin_engine::manifest::PluginConfigField;
use crate::provider_config;
use aes_gcm::{
    AesGcm, Nonce,
    aead::{Aead, KeyInit, OsRng, generic_array::typenum::U16, rand_core::RngCore},
    aes::Aes256,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use rquickjs::{Ctx, Exception, Function, IntoJs, Object, Value, function::Rest};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const WHITELISTED_ENV_VARS: [&str; 33] = [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "USER_TYPE",
    "USE_STAGING_OAUTH",
    "USE_LOCAL_OAUTH",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    "ZAI_API_KEY",
    "GLM_API_KEY",
    "BIGMODEL_API_KEY",
    "ZHIPUAI_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_API_TOKEN",
    "MINIMAX_CN_API_KEY",
    "SYNTHETIC_API_KEY",
    "PI_CODING_AGENT_DIR",
    "OPENAI_ADMIN_KEY",
    "OPENAI_API_KEY",
    "OPENAI_PROJECT_ID",
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_URL",
    "OPENROUTER_HTTP_REFERER",
    "OPENROUTER_X_TITLE",
    "GEMINI_CONFIG_DIR",
    "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
    "ALIBABA_CODING_PLAN_COOKIE",
    "ALIBABA_TOKEN_PLAN_COOKIE",
    "OPENCODE_COOKIE",
    "OPENCODE_WORKSPACE_ID",
];
const MIN_BLOCKING_TIMEOUT: Duration = Duration::from_millis(1);

fn is_env_var_allowed_for_plugin(plugin_id: &str, name: &str) -> bool {
    if !WHITELISTED_ENV_VARS.contains(&name) {
        return false;
    }

    match plugin_id {
        "claude" => matches!(
            name,
            "CLAUDE_CONFIG_DIR"
                | "CLAUDE_CODE_OAUTH_TOKEN"
                | "USER_TYPE"
                | "USE_STAGING_OAUTH"
                | "USE_LOCAL_OAUTH"
                | "CLAUDE_CODE_CUSTOM_OAUTH_URL"
                | "CLAUDE_CODE_OAUTH_CLIENT_ID"
                | "CLAUDE_LOCAL_OAUTH_API_BASE"
        ),
        "codex" => matches!(name, "CODEX_HOME"),
        "zai" => matches!(name, "ZAI_API_KEY" | "GLM_API_KEY"),
        "bigmodel-cn" => matches!(name, "BIGMODEL_API_KEY" | "ZHIPUAI_API_KEY"),
        "minimax" => matches!(
            name,
            "MINIMAX_API_KEY" | "MINIMAX_API_TOKEN" | "MINIMAX_CN_API_KEY"
        ),
        "synthetic" => matches!(name, "SYNTHETIC_API_KEY" | "PI_CODING_AGENT_DIR"),
        "openai-api" => matches!(
            name,
            "OPENAI_ADMIN_KEY" | "OPENAI_API_KEY" | "OPENAI_PROJECT_ID"
        ),
        "openrouter" => matches!(
            name,
            "OPENROUTER_API_KEY"
                | "OPENROUTER_API_URL"
                | "OPENROUTER_HTTP_REFERER"
                | "OPENROUTER_X_TITLE"
        ),
        "gemini" => matches!(name, "GEMINI_CONFIG_DIR"),
        "alibaba-coding-plan" => matches!(
            name,
            "ALIBABA_CODING_PLAN_API_KEY"
                | "ALIBABA_QWEN_API_KEY"
                | "DASHSCOPE_API_KEY"
                | "ALIBABA_CODING_PLAN_COOKIE"
        ),
        "alibaba-token-plan" => matches!(name, "ALIBABA_TOKEN_PLAN_COOKIE"),
        "opencode" => matches!(name, "OPENCODE_COOKIE" | "OPENCODE_WORKSPACE_ID"),
        _ => false,
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProbeDeadline {
    expires_at: Option<Instant>,
}

impl ProbeDeadline {
    #[cfg(test)]
    pub(crate) fn none() -> Self {
        Self { expires_at: None }
    }

    pub(crate) fn at(expires_at: Instant) -> Self {
        Self {
            expires_at: Some(expires_at),
        }
    }

    pub(crate) fn has_elapsed(self) -> bool {
        self.expires_at
            .map(|expires_at| Instant::now() >= expires_at)
            .unwrap_or(false)
    }

    fn clamp_duration(self, requested: Duration) -> Option<Duration> {
        let Some(expires_at) = self.expires_at else {
            return Some(requested);
        };
        let remaining = expires_at
            .checked_duration_since(Instant::now())
            .filter(|remaining| *remaining >= MIN_BLOCKING_TIMEOUT)?;
        Some(requested.min(remaining))
    }
}

fn log_probe_deadline_skip(plugin_id: &str, operation: &str) {
    log::warn!(
        "[plugin:{}] {} skipped: probe timed out",
        plugin_id,
        operation
    );
}

fn probe_timeout_error<'js>(ctx: &Ctx<'js>) -> rquickjs::Error {
    Exception::throw_message(ctx, "probe timed out")
}

fn last_non_empty_trimmed_line(text: &str) -> Option<String> {
    text.lines()
        .map(|line| line.trim())
        .rev()
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn sanitize_env_value(text: &str) -> Option<String> {
    let mut cleaned = if let Ok(ansi_re) = regex_lite::Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]") {
        ansi_re.replace_all(text, "").to_string()
    } else {
        text.to_string()
    };
    cleaned.retain(|ch| ch == '\n' || ch == '\r' || ch == '\t' || !ch.is_control());
    last_non_empty_trimmed_line(&cleaned)
}

fn extract_marked_value(text: &str, start_marker: &str, end_marker: &str) -> Option<String> {
    let start = text.find(start_marker)?;
    let after_start = &text[start + start_marker.len()..];
    let end = after_start.find(end_marker)?;
    sanitize_env_value(&after_start[..end])
}

fn parse_interactive_shell_env_output(
    text: &str,
    start_marker: &str,
    end_marker: &str,
) -> Option<String> {
    if let Some(marked) = extract_marked_value(text, start_marker, end_marker) {
        return Some(marked);
    }

    let has_complete_markers = text.contains(start_marker) && text.contains(end_marker);
    if has_complete_markers {
        return None;
    }

    sanitize_env_value(text)
}

fn read_env_from_process(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    sanitize_env_value(&value)
}

fn read_command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn read_env_value_via_command(program: &str, args: &[&str]) -> Option<String> {
    let stdout = read_command_stdout(program, args)?;
    sanitize_env_value(&stdout)
}

fn current_macos_keychain_account_from_user_env(user_env: Option<String>) -> String {
    user_env
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .or_else(|| read_env_value_via_command("id", &["-un"]))
        .unwrap_or_else(|| "openusagecn-user".to_string())
}

fn current_macos_keychain_account() -> String {
    current_macos_keychain_account_from_user_env(read_env_from_process("USER"))
}

fn keychain_find_generic_password_args(service: &str) -> Vec<OsString> {
    vec![
        OsString::from("find-generic-password"),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
    ]
}

fn keychain_find_generic_password_args_for_account(service: &str, account: &str) -> Vec<OsString> {
    vec![
        OsString::from("find-generic-password"),
        OsString::from("-a"),
        OsString::from(account),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
    ]
}

fn keychain_add_generic_password_args(service: &str, value: &str) -> Vec<OsString> {
    vec![
        OsString::from("add-generic-password"),
        OsString::from("-U"),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
        OsString::from(value),
    ]
}

fn keychain_add_generic_password_args_for_account(
    service: &str,
    account: &str,
    value: &str,
) -> Vec<OsString> {
    vec![
        OsString::from("add-generic-password"),
        OsString::from("-U"),
        OsString::from("-a"),
        OsString::from(account),
        OsString::from("-s"),
        OsString::from(service),
        OsString::from("-w"),
        OsString::from(value),
    ]
}

fn terminal_env_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shell_from_env() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let trimmed = shell.trim();
    if trimmed.is_empty() {
        return None;
    }
    let file = std::path::Path::new(trimmed).file_name()?.to_string_lossy();
    let allowed = file == "zsh" || file == "bash" || file == "fish";
    if allowed {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn read_env_from_interactive_shell(program: &str, name: &str) -> Option<String> {
    const START_MARKER: &str = "__OPENUSAGECN_ENV_START__";
    const END_MARKER: &str = "__OPENUSAGECN_ENV_END__";

    let script = format!(
        "printf '{}\\n'; printenv {}; printf '{}\\n'",
        START_MARKER, name, END_MARKER
    );
    let output = read_command_stdout(program, &["-ilc", script.as_str()])?;
    parse_interactive_shell_env_output(&output, START_MARKER, END_MARKER)
}

fn read_env_from_interactive_shells(name: &str) -> Option<String> {
    let mut programs: Vec<String> = Vec::new();

    if let Some(shell) = shell_from_env() {
        programs.push(shell);
    }

    for program in [
        "/bin/zsh",
        "/bin/bash",
        "/opt/homebrew/bin/fish",
        "/usr/local/bin/fish",
        "/opt/local/bin/fish",
    ] {
        if !programs.iter().any(|p| p == program) {
            programs.push(program.to_string());
        }
    }

    for program in programs {
        if let Some(value) = read_env_from_interactive_shell(program.as_str(), name) {
            return Some(value);
        }
    }

    None
}

fn resolve_env_value(name: &str) -> Option<String> {
    // Prefer the current process env (fast + supports launchctl/terminal-launch).
    if let Some(value) = read_env_from_process(name) {
        return Some(value);
    }

    if let Ok(cache) = terminal_env_cache().lock() {
        if let Some(cached) = cache.get(name) {
            return cached.clone();
        }
    }

    let resolved = read_env_from_interactive_shells(name);
    if let Ok(mut cache) = terminal_env_cache().lock() {
        cache.insert(name.to_string(), resolved.clone());
    }
    resolved
}

/// Redact sensitive value to first4...last4 format (UTF-8 safe)
fn redact_value(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 12 {
        "[REDACTED]".to_string()
    } else {
        let first4: String = chars.iter().take(4).collect();
        let last4: String = chars
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{}...{}", first4, last4)
    }
}

fn dynamic_secret_values() -> &'static Mutex<HashSet<String>> {
    static SECRETS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SECRETS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn register_secret_for_redaction(value: &str) {
    let trimmed = value.trim();
    if trimmed.chars().count() < 8 {
        return;
    }
    if let Ok(mut secrets) = dynamic_secret_values().lock() {
        secrets.insert(trimmed.to_string());
    }
}

/// Redact sensitive query parameters in URL
fn redact_url(url: &str) -> String {
    let sensitive_params = [
        "key",
        "api_key",
        "apikey",
        "token",
        "access_token",
        "secret",
        "password",
        "auth",
        "authorization",
        "bearer",
        "credential",
        "user",
        "user_id",
        "userid",
        "account_id",
        "accountid",
        "profilearn",
        "profile_arn",
        "profilekey",
        "profile_key",
        "candidateid",
        "candidate_id",
        "sessionref",
        "session_ref",
        "storeid",
        "store_id",
        "subject",
        "sub",
        "normalizedidentity",
        "normalized_identity",
        "organizationuuid",
        "organization_uuid",
        "owninguser",
        "owning_user",
        "owningteam",
        "owning_team",
        "credentialgeneration",
        "credential_generation",
        "email",
        "login",
    ];

    if let Some(query_start) = url.find('?') {
        let (base, query) = url.split_at(query_start + 1);
        let redacted_params: Vec<String> = query
            .split('&')
            .map(|param| {
                if let Some(eq_pos) = param.find('=') {
                    let (name, value) = param.split_at(eq_pos);
                    let value = &value[1..]; // skip '='
                    let name_lower = name.to_lowercase();
                    if sensitive_params.iter().any(|s| name_lower.contains(s)) && !value.is_empty()
                    {
                        format!("{}={}", name, redact_value(value))
                    } else {
                        param.to_string()
                    }
                } else {
                    param.to_string()
                }
            })
            .collect();
        format!("{}{}", base, redacted_params.join("&"))
    } else {
        url.to_string()
    }
}

/// Redact sensitive patterns in response body for logging
fn redact_body(body: &str) -> String {
    let mut result = body.to_string();

    // Redact JWTs (eyJ... pattern with dots)
    let jwt_pattern =
        regex_lite::Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap();
    result = jwt_pattern
        .replace_all(&result, |caps: &regex_lite::Captures| {
            redact_value(&caps[0])
        })
        .to_string();

    // Redact common API key patterns (sk-xxx, pk-xxx, api_xxx, etc.)
    let api_key_pattern =
        regex_lite::Regex::new(r#"["']?(sk-|pk-|api_|key_|secret_)[A-Za-z0-9_-]{12,}["']?"#)
            .unwrap();
    result = api_key_pattern
        .replace_all(&result, |caps: &regex_lite::Captures| {
            let key = caps[0].trim_matches(|c| c == '"' || c == '\'');
            redact_value(key)
        })
        .to_string();

    if let Ok(devin_session_re) = regex_lite::Regex::new(r#"devin-session-token\$[^\s"',}\]]+"#) {
        result = devin_session_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                redact_value(&caps[0])
            })
            .to_string();
    }

    // Redact JSON values for sensitive keys
    let sensitive_keys = [
        "name",
        "password",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "api_key",
        "apiKey",
        "authorization",
        "bearer",
        "credential",
        "session_token",
        "sessionToken",
        "cookie",
        "cookieHeader",
        "cookie_header",
        "setCookie",
        "set_cookie",
        "candidateId",
        "candidate_id",
        "sessionRef",
        "session_ref",
        "storeId",
        "store_id",
        "subject",
        "sub",
        "normalizedIdentity",
        "normalized_identity",
        "profileKey",
        "profile_key",
        "organizationUuid",
        "organization_uuid",
        "emailAddress",
        "email_address",
        "owningUser",
        "owning_user",
        "owningTeam",
        "owning_team",
        "credentialGeneration",
        "credential_generation",
        "auth_token",
        "authToken",
        "id_token",
        "idToken",
        "accessToken",
        "refreshToken",
        "user_id",
        "userId",
        "account_id",
        "accountId",
        "team_id",
        "teamId",
        "org_id",
        "orgId",
        "account_display_name",
        "accountDisplayName",
        "payment_id",
        "paymentId",
        "profile_arn",
        "profileArn",
        "email",
        "login",
        "analytics_tracking_id",
    ];
    for key in sensitive_keys {
        // Match "key": "value" or "key":"value"
        let pattern = format!(r#""{}":\s*"([^"]+)""#, key);
        if let Ok(re) = regex_lite::Regex::new(&pattern) {
            result = re
                .replace_all(&result, |caps: &regex_lite::Captures| {
                    let value = &caps[1];
                    format!("\"{}\": \"{}\"", key, redact_value(value))
                })
                .to_string();
        }
    }

    let form_secret_re = regex_lite::Regex::new(
        r#"(?i)(^|[&\s])([A-Za-z0-9_.-]*(?:token|secret|password|auth|credential|cookie|csrf)[A-Za-z0-9_.-]*)=([^&\s]+)"#,
    )
    .expect("valid form secret redaction regex");
    result = form_secret_re
        .replace_all(&result, |caps: &regex_lite::Captures| {
            format!("{}{}={}", &caps[1], &caps[2], redact_value(&caps[3]))
        })
        .to_string();

    if let Ok(path_re) =
        regex_lite::Regex::new(r#"(/(?:Users|home|opt|private|var|tmp|Applications)/[^\s"')]+)"#)
    {
        result = path_re.replace_all(&result, "[PATH]").to_string();
    }

    result
}

fn redact_http_response_body(url: &str, body: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let body = if path.ends_with("/wham/rate-limit-reset-credits") {
        redact_codex_reset_credit_inventory_sensitive_fields(body)
    } else {
        body.to_string()
    };
    redact_body(&body)
}

fn redact_codex_reset_credit_inventory_sensitive_fields(body: &str) -> String {
    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_string();
    };
    let Some(root) = payload.as_object_mut() else {
        return body.to_string();
    };
    let Some(credits) = root
        .get_mut("credits")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return body.to_string();
    };

    let mut changed = false;
    for credit in credits {
        let Some(credit) = credit.as_object_mut() else {
            continue;
        };
        for key in ["id", "profile_user_id", "profile_image_url"] {
            let Some(value) = credit.get_mut(key) else {
                continue;
            };
            let Some(raw_value) = value.as_str() else {
                continue;
            };
            *value = serde_json::Value::String(redact_value(raw_value));
            changed = true;
        }
    }

    if !changed {
        return body.to_string();
    }
    serde_json::to_string(&payload).unwrap_or_else(|_| body.to_string())
}

/// Lightweight redaction for log messages.
pub(crate) fn redact_log_message(msg: &str) -> String {
    let mut result = msg.to_string();
    if let Ok(secrets) = dynamic_secret_values().lock() {
        let mut values: Vec<String> = secrets.iter().cloned().collect();
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        for secret in values {
            if result.contains(&secret) {
                result = result.replace(&secret, &redact_value(&secret));
            }
        }
    }
    if let Ok(jwt_re) = regex_lite::Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
    {
        result = jwt_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                redact_value(&caps[0])
            })
            .to_string();
    }
    if let Ok(api_re) = regex_lite::Regex::new(r#"(sk-|pk-|api_|key_|secret_)[A-Za-z0-9_-]{12,}"#) {
        result = api_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                redact_value(&caps[0])
            })
            .to_string();
    }
    if let Ok(devin_session_re) = regex_lite::Regex::new(r#"devin-session-token\$[^\s"',}\]]+"#) {
        result = devin_session_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                redact_value(&caps[0])
            })
            .to_string();
    }
    if let Ok(account_re) = regex_lite::Regex::new(r#"(account=)([^,\s]+)"#) {
        result = account_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                format!("{}{}", &caps[1], redact_value(&caps[2]))
            })
            .to_string();
    }
    if let Ok(path_re) =
        regex_lite::Regex::new(r#"(/(?:Users|home|opt|private|var|tmp|Applications)/[^\s"')]+)"#)
    {
        result = path_re.replace_all(&result, "[PATH]").to_string();
    }
    if let Ok(windows_drive_path_re) =
        regex_lite::Regex::new(r#"(?i)(^|[\s=\"'(])((?:\\\\\?\\)?[a-z]:[\\/][^,;\r\n\"')]+)"#)
    {
        result = windows_drive_path_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                format!("{}[PATH]", &caps[1])
            })
            .to_string();
    }
    if let Ok(windows_unc_path_re) = regex_lite::Regex::new(
        r#"(?i)(^|[\s=\"'(])(\\\\(?:\?\\UNC\\)?[^\\/\s]+[\\/][^,;\r\n\"')]+)"#,
    ) {
        result = windows_unc_path_re
            .replace_all(&result, |caps: &regex_lite::Captures| {
                format!("{}[PATH]", &caps[1])
            })
            .to_string();
    }
    result
}

fn decrypt_aes_256_gcm_envelope(envelope: &str, key_b64: &str) -> Result<String, String> {
    let trimmed_envelope = envelope.trim();
    let trimmed_key = key_b64.trim();
    let parts: Vec<&str> = trimmed_envelope.split(':').collect();
    if parts.len() != 3 {
        return Err("invalid AES-GCM envelope".to_string());
    }

    let key = BASE64_STANDARD
        .decode(trimmed_key)
        .map_err(|e| format!("invalid base64 key: {}", e))?;
    if key.len() != 32 {
        return Err(format!(
            "invalid AES-256 key length: expected 32 bytes, got {}",
            key.len()
        ));
    }

    let iv = BASE64_STANDARD
        .decode(parts[0])
        .map_err(|e| format!("invalid base64 iv: {}", e))?;
    if iv.len() != 16 {
        return Err(format!(
            "invalid AES-GCM iv length: expected 16 bytes, got {}",
            iv.len()
        ));
    }

    let tag = BASE64_STANDARD
        .decode(parts[1])
        .map_err(|e| format!("invalid base64 auth tag: {}", e))?;
    if tag.len() != 16 {
        return Err(format!(
            "invalid AES-GCM auth tag length: expected 16 bytes, got {}",
            tag.len()
        ));
    }

    let ciphertext = BASE64_STANDARD
        .decode(parts[2])
        .map_err(|e| format!("invalid base64 ciphertext: {}", e))?;

    type Aes256Gcm16 = AesGcm<Aes256, U16>;
    let cipher =
        Aes256Gcm16::new_from_slice(&key).map_err(|e| format!("decrypt init failed: {}", e))?;
    let nonce = Nonce::<U16>::from_slice(&iv);

    let mut ciphertext_and_tag = ciphertext;
    ciphertext_and_tag.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(nonce, ciphertext_and_tag.as_ref())
        .map_err(|_| "decrypt finalize failed".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("decrypted payload is not UTF-8: {}", e))
}

fn encrypt_aes_256_gcm_envelope(plaintext: &str, key_b64: &str) -> Result<String, String> {
    let trimmed_key = key_b64.trim();
    let key = BASE64_STANDARD
        .decode(trimmed_key)
        .map_err(|e| format!("invalid base64 key: {}", e))?;
    if key.len() != 32 {
        return Err(format!(
            "invalid AES-256 key length: expected 32 bytes, got {}",
            key.len()
        ));
    }

    type Aes256Gcm16 = AesGcm<Aes256, U16>;
    let cipher =
        Aes256Gcm16::new_from_slice(&key).map_err(|e| format!("encrypt init failed: {}", e))?;
    let mut iv = [0_u8; 16];
    OsRng.fill_bytes(&mut iv);
    let nonce = Nonce::<U16>::from_slice(&iv);
    let ciphertext_and_tag = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "encrypt finalize failed".to_string())?;
    if ciphertext_and_tag.len() < 16 {
        return Err("encrypted payload missing auth tag".to_string());
    }
    let split_at = ciphertext_and_tag.len() - 16;
    let (ciphertext, tag) = ciphertext_and_tag.split_at(split_at);

    Ok(format!(
        "{}:{}:{}",
        BASE64_STANDARD.encode(iv),
        BASE64_STANDARD.encode(tag),
        BASE64_STANDARD.encode(ciphertext)
    ))
}

#[cfg(test)]
pub(crate) fn inject_host_api<'js>(
    ctx: &Ctx<'js>,
    plugin_id: &str,
    app_data_dir: &PathBuf,
    app_version: &str,
) -> rquickjs::Result<()> {
    inject_host_api_with_deadline(
        ctx,
        plugin_id,
        app_data_dir,
        app_version,
        &[],
        ProbeDeadline::none(),
    )
}

pub(crate) fn inject_host_api_with_deadline<'js>(
    ctx: &Ctx<'js>,
    plugin_id: &str,
    app_data_dir: &PathBuf,
    app_version: &str,
    config_fields: &[PluginConfigField],
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    let probe_ctx = Object::new(ctx.clone())?;

    probe_ctx.set("nowIso", iso_now())?;

    let app_obj = Object::new(ctx.clone())?;
    app_obj.set("version", app_version)?;
    app_obj.set("platform", std::env::consts::OS)?;
    app_obj.set("appDataDir", app_data_dir.to_string_lossy().to_string())?;
    let plugin_data_dir = app_data_dir.join("plugins_data").join(plugin_id);
    if let Err(err) = std::fs::create_dir_all(&plugin_data_dir) {
        log::warn!(
            "[plugin:{}] failed to create plugin data dir: {}",
            plugin_id,
            err
        );
    }
    app_obj.set(
        "pluginDataDir",
        plugin_data_dir.to_string_lossy().to_string(),
    )?;
    probe_ctx.set("app", app_obj)?;

    let host = Object::new(ctx.clone())?;
    inject_log(ctx, &host, plugin_id)?;
    inject_fs(ctx, &host)?;
    inject_crypto(ctx, &host)?;
    inject_config(ctx, &host, plugin_id, config_fields)?;
    inject_env(ctx, &host, plugin_id)?;
    inject_http(ctx, &host, plugin_id, deadline)?;
    inject_keychain(ctx, &host, plugin_id)?;
    inject_sqlite(ctx, &host)?;
    inject_ls(ctx, &host, plugin_id)?;
    inject_ccusage(ctx, &host, plugin_id, deadline)?;

    probe_ctx.set("host", host)?;
    globals.set("__openusage_ctx", probe_ctx)?;
    patch_config_wrapper(ctx)?;

    Ok(())
}

fn inject_config<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
    config_fields: &[PluginConfigField],
) -> rquickjs::Result<()> {
    let values = provider_config::resolved_values(plugin_id, config_fields);
    let values_json = serde_json::to_string(&values)
        .map_err(|e| Exception::throw_message(ctx, &format!("config encode failed: {}", e)))?;
    let config_obj = Object::new(ctx.clone())?;
    config_obj.set("_valuesJson", values_json)?;
    host.set("config", config_obj)?;
    Ok(())
}

fn patch_config_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var raw = __openusage_ctx.host.config._valuesJson || "{}";
            var values = {};
            try {
                values = JSON.parse(raw) || {};
            } catch (e) {
                values = {};
            }
            __openusage_ctx.host.config = {
                get: function(name) {
                    if (typeof name !== "string") return null;
                    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
                },
                all: function() {
                    var copy = {};
                    for (var key in values) {
                        if (Object.prototype.hasOwnProperty.call(values, key)) {
                            copy[key] = values[key];
                        }
                    }
                    return copy;
                }
            };
        })();
        "#
        .as_bytes(),
    )
}

fn inject_log<'js>(ctx: &Ctx<'js>, host: &Object<'js>, plugin_id: &str) -> rquickjs::Result<()> {
    let log_obj = Object::new(ctx.clone())?;

    let pid = plugin_id.to_string();
    log_obj.set(
        "info",
        Function::new(ctx.clone(), move |msg: String| {
            log::info!("[plugin:{}] {}", pid, redact_log_message(&msg));
        })?,
    )?;

    let pid = plugin_id.to_string();
    log_obj.set(
        "warn",
        Function::new(ctx.clone(), move |msg: String| {
            log::warn!("[plugin:{}] {}", pid, redact_log_message(&msg));
        })?,
    )?;

    let pid = plugin_id.to_string();
    log_obj.set(
        "error",
        Function::new(ctx.clone(), move |msg: String| {
            log::error!("[plugin:{}] {}", pid, redact_log_message(&msg));
        })?,
    )?;

    host.set("log", log_obj)?;
    Ok(())
}

fn inject_fs<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    let fs_obj = Object::new(ctx.clone())?;

    fs_obj.set(
        "exists",
        Function::new(ctx.clone(), move |path: String| -> bool {
            let expanded = expand_path(&path);
            std::path::Path::new(&expanded).exists()
        })?,
    )?;

    fs_obj.set(
        "readText",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                let expanded = expand_path(&path);
                std::fs::read_to_string(&expanded)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))
            },
        )?,
    )?;

    fs_obj.set(
        "writeText",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, path: String, content: String| -> rquickjs::Result<()> {
                let expanded = expand_path(&path);
                std::fs::write(&expanded, &content)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))
            },
        )?,
    )?;

    fs_obj.set(
        "writeTextIfUnchanged",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  path: String,
                  content: String,
                  expected_sha256: String|
                  -> rquickjs::Result<bool> {
                let expanded = expand_path(&path);
                crate::safe_file::write_text_if_unchanged(
                    std::path::Path::new(&expanded),
                    &content,
                    &expected_sha256,
                )
                .map_err(|e| Exception::throw_message(&ctx_inner, &e))
            },
        )?,
    )?;

    fs_obj.set(
        "listDir",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, path: String| -> rquickjs::Result<Vec<String>> {
                let expanded = expand_path(&path);
                let entries = std::fs::read_dir(&expanded)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;

                let mut names = Vec::new();
                for entry in entries {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(_) => continue,
                    };
                    let name_os = entry.file_name();
                    let name = name_os.to_string_lossy().to_string();
                    if !name.is_empty() {
                        names.push(name);
                    }
                }
                names.sort();
                Ok(names)
            },
        )?,
    )?;

    host.set("fs", fs_obj)?;
    Ok(())
}

fn inject_crypto<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    let crypto_obj = Object::new(ctx.clone())?;

    crypto_obj.set(
        "decryptAes256Gcm",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  envelope: String,
                  key_b64: String|
                  -> rquickjs::Result<String> {
                decrypt_aes_256_gcm_envelope(&envelope, &key_b64)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e))
            },
        )?,
    )?;

    crypto_obj.set(
        "encryptAes256Gcm",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  plaintext: String,
                  key_b64: String|
                  -> rquickjs::Result<String> {
                encrypt_aes_256_gcm_envelope(&plaintext, &key_b64)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e))
            },
        )?,
    )?;

    crypto_obj.set(
        "sha256Hex",
        Function::new(ctx.clone(), move |text: String| -> String {
            let digest = Sha256::digest(text.as_bytes());
            // Lowercase hex, matches Node's `crypto.createHash("sha256").update(x).digest("hex")`
            // and the upstream Claude Code keychain helper.
            let mut out = String::with_capacity(digest.len() * 2);
            for byte in digest.iter() {
                use std::fmt::Write as _;
                let _ = write!(&mut out, "{:02x}", byte);
            }
            out
        })?,
    )?;

    host.set("crypto", crypto_obj)?;
    Ok(())
}

fn inject_env<'js>(ctx: &Ctx<'js>, host: &Object<'js>, plugin_id: &str) -> rquickjs::Result<()> {
    let env_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();
    env_obj.set(
        "get",
        Function::new(ctx.clone(), move |name: String| -> Option<String> {
            if !is_env_var_allowed_for_plugin(&pid, &name) {
                return None;
            }

            resolve_env_value(&name)
        })?,
    )?;
    host.set("env", env_obj)?;
    Ok(())
}

fn normalize_https_base_url_for_js<'js>(
    ctx: Ctx<'js>,
    raw: String,
) -> rquickjs::Result<Value<'js>> {
    match super::endpoint_url::normalize_https_base_url(&raw) {
        Some(value) => value.into_js(&ctx),
        None => Ok(Value::new_null(ctx)),
    }
}

fn inject_http<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let http_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();

    http_obj.set(
        "normalizeHttpsBaseUrl",
        Function::new(ctx.clone(), normalize_https_base_url_for_js)?,
    )?;

    http_obj.set(
        "_requestRaw",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, req_json: String| -> rquickjs::Result<String> {
                let req: HttpReqParams = serde_json::from_str(&req_json).map_err(|e| {
                    Exception::throw_message(&ctx_inner, &format!("invalid request: {}", e))
                })?;

                if deadline.has_elapsed() {
                    return Err(Exception::throw_message(&ctx_inner, "probe timed out"));
                }

                let method_str = req.method.as_deref().unwrap_or("GET");
                let redacted_url = redact_url(&req.url);
                log::info!("[plugin:{}] HTTP {} {}", pid, method_str, redacted_url);

                let mut header_map = reqwest::header::HeaderMap::new();
                if let Some(headers) = &req.headers {
                    for (key, val) in headers {
                        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                            .map_err(|e| {
                                Exception::throw_message(
                                    &ctx_inner,
                                    &format!("invalid header name '{}': {}", key, e),
                                )
                            })?;
                        let value = reqwest::header::HeaderValue::from_str(val).map_err(|e| {
                            Exception::throw_message(
                                &ctx_inner,
                                &format!("invalid header value for '{}': {}", key, e),
                            )
                        })?;
                        header_map.insert(name, value);
                    }
                }

                let timeout_ms = req.timeout_ms.unwrap_or(10_000);
                let Some(timeout) = deadline.clamp_duration(Duration::from_millis(timeout_ms))
                else {
                    return Err(probe_timeout_error(&ctx_inner));
                };
                let mut builder = reqwest::blocking::Client::builder()
                    .timeout(timeout)
                    .connect_timeout(timeout)
                    .redirect(reqwest::redirect::Policy::none());

                // Apply pre-resolved proxy (localhost bypass already configured)
                if let Some(resolved) = crate::config::get_resolved_proxy() {
                    builder = builder.proxy(resolved.proxy.clone());
                    log::debug!("[http] proxy active");
                } else {
                    log::debug!(
                        "[http] no manual proxy configured; automatic proxy discovery may apply"
                    );
                }

                if req.dangerously_ignore_tls.unwrap_or(false) {
                    builder = builder.danger_accept_invalid_certs(true);
                }
                let client = builder
                    .build()
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;

                let method = req.method.as_deref().unwrap_or("GET");
                let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| {
                    Exception::throw_message(
                        &ctx_inner,
                        &format!("invalid http method '{}': {}", method, e),
                    )
                })?;
                let mut builder = client.request(method, &req.url);
                builder = builder.headers(header_map);
                if let Some(body) = req.body_text {
                    builder = builder.body(body);
                }

                let response = builder
                    .send()
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;

                let status = response.status().as_u16();
                let mut resp_headers = std::collections::HashMap::new();
                for (key, value) in response.headers().iter() {
                    let header_value = value.to_str().map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("invalid response header '{}': {}", key, e),
                        )
                    })?;
                    resp_headers.insert(key.to_string(), header_value.to_string());
                }
                let body = response
                    .text()
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))?;

                // Redact BEFORE truncation to ensure sensitive values are caught while intact
                let redacted_body = redact_http_response_body(&req.url, &body);
                let body_preview = if redacted_body.len() > 500 {
                    // UTF-8 safe truncation: find valid char boundary at or before 500
                    let truncated: String = redacted_body
                        .char_indices()
                        .take_while(|(i, _)| *i < 500)
                        .map(|(_, c)| c)
                        .collect();
                    format!("{}... ({} bytes total)", truncated, body.len())
                } else {
                    redacted_body
                };
                log::info!(
                    "[plugin:{}] HTTP {} {} -> {} | {}",
                    pid,
                    method_str,
                    redacted_url,
                    status,
                    body_preview
                );

                let resp = HttpRespParams {
                    status,
                    headers: resp_headers,
                    body_text: body,
                };

                serde_json::to_string(&resp)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e.to_string()))
            },
        )?,
    )?;

    ctx.eval::<(), _>(
        r#"
        (function() {
            // Will be patched after __openusage_ctx is set.
            if (typeof __openusage_ctx !== "undefined") {
                void 0;
            }
        })();
        "#
        .as_bytes(),
    )
    .map_err(|e| Exception::throw_message(ctx, &format!("http wrapper init failed: {}", e)))?;

    host.set("http", http_obj)?;
    Ok(())
}

pub fn patch_http_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var rawFn = __openusage_ctx.host.http._requestRaw;
            __openusage_ctx.host.http.request = function(req) {
                var json = JSON.stringify({
                    url: req.url,
                    method: req.method || "GET",
                    headers: req.headers || null,
                    bodyText: req.bodyText || null,
                    timeoutMs: req.timeoutMs || 10000,
                    dangerouslyIgnoreTls: req.dangerouslyIgnoreTls || false
                });
                var respJson = rawFn(json);
                return JSON.parse(respJson);
            };
        })();
        "#
        .as_bytes(),
    )
}

/// Inject utility APIs (line builders, formatters, base64, jwt) onto __openusage_ctx
pub fn inject_utils(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var ctx = __openusage_ctx;

            // Line builders (options object API)
            ctx.line = {
                text: function(opts) {
                    var line = { type: "text", label: opts.label, value: opts.value };
                    if (opts.color) line.color = opts.color;
                    if (opts.subtitle) line.subtitle = opts.subtitle;
                    return line;
                },
                progress: function(opts) {
                    var line = { type: "progress", label: opts.label, used: opts.used, limit: opts.limit, format: opts.format };
                    if (opts.limitResourceKey) line.limitResourceKey = opts.limitResourceKey;
                    if (opts.resetsAt) line.resetsAt = opts.resetsAt;
                    if (opts.periodDurationMs) line.periodDurationMs = opts.periodDurationMs;
                    if (opts.color) line.color = opts.color;
                    return line;
                },
                badge: function(opts) {
                    var line = { type: "badge", label: opts.label, text: opts.text };
                    if (opts.color) line.color = opts.color;
                    if (opts.subtitle) line.subtitle = opts.subtitle;
                    return line;
                },
                barChart: function(opts) {
                    var line = { type: "barChart", label: opts.label, points: opts.points || [] };
                    if (opts.note) line.note = opts.note;
                    if (opts.color) line.color = opts.color;
                    return line;
                }
            };

            // Formatters
            ctx.fmt = {
                planLabel: function(value) {
                    var text = String(value || "").trim();
                    if (!text) return "";
                    return text.replace(/(^|\s)([a-z])/g, function(match, space, letter) {
                        return space + letter.toUpperCase();
                    });
                },
                resetIn: function(secondsUntil) {
                    if (!Number.isFinite(secondsUntil) || secondsUntil < 0) return null;
                    var totalMinutes = Math.floor(secondsUntil / 60);
                    var totalHours = Math.floor(totalMinutes / 60);
                    var days = Math.floor(totalHours / 24);
                    var hours = totalHours % 24;
                    var minutes = totalMinutes % 60;
                    if (days > 0) return days + "d " + hours + "h";
                    if (totalHours > 0) return totalHours + "h " + minutes + "m";
                    if (totalMinutes > 0) return totalMinutes + "m";
                    return "<1m";
                },
                dollars: function(cents) {
                    var d = cents / 100;
                    return Math.round(d * 100) / 100;
                },
                date: function(unixMs) {
                    var d = new Date(Number(unixMs));
                    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    return months[d.getMonth()] + " " + String(d.getDate());
                }
            };

            // Shared utilities
            ctx.util = {
                tryParseJson: function(text) {
                    if (text === null || text === undefined) return null;
                    var trimmed = String(text).trim();
                    if (!trimmed) return null;
                    try {
                        return JSON.parse(trimmed);
                    } catch (e) {
                        return null;
                    }
                },
                safeJsonParse: function(text) {
                    if (text === null || text === undefined) return { ok: false };
                    var trimmed = String(text).trim();
                    if (!trimmed) return { ok: false };
                    try {
                        return { ok: true, value: JSON.parse(trimmed) };
                    } catch (e) {
                        return { ok: false };
                    }
                },
                request: function(opts) {
                    return ctx.host.http.request(opts);
                },
                requestJson: function(opts) {
                    var resp = ctx.util.request(opts);
                    var parsed = ctx.util.safeJsonParse(resp.bodyText);
                    return { resp: resp, json: parsed.ok ? parsed.value : null };
                },
                isAuthStatus: function(status) {
                    return status === 401 || status === 403;
                },
                retryOnceOnAuth: function(opts) {
                    var resp = opts.request();
                    if (ctx.util.isAuthStatus(resp.status)) {
                        var token = opts.refresh();
                        if (token) {
                            resp = opts.request(token);
                        }
                    }
                    return resp;
                },
                parseDateMs: function(value) {
                    if (value instanceof Date) {
                        var dateMs = value.getTime();
                        return Number.isFinite(dateMs) ? dateMs : null;
                    }
                    if (typeof value === "number") {
                        return Number.isFinite(value) ? value : null;
                    }
                    if (typeof value === "string") {
                        var parsed = Date.parse(value);
                        if (Number.isFinite(parsed)) return parsed;
                        var n = Number(value);
                        return Number.isFinite(n) ? n : null;
                    }
                    return null;
                },
                toIso: function(value) {
                    if (value === null || value === undefined) return null;

                    if (typeof value === "string") {
                        var s = String(value).trim();
                        if (!s) return null;

                        // Common variants
                        // - "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS"
                        // - "... UTC" -> "...Z"
                        if (s.indexOf(" ") !== -1 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
                            s = s.replace(" ", "T");
                        }
                        if (s.endsWith(" UTC")) {
                            s = s.slice(0, -4) + "Z";
                        }

                        // Numeric strings: treat as seconds/ms.
                        if (/^-?\d+(\.\d+)?$/.test(s)) {
                            var n = Number(s);
                            if (!Number.isFinite(n)) return null;
                            var msNum = Math.abs(n) < 1e10 ? n * 1000 : n;
                            var dn = new Date(msNum);
                            var tn = dn.getTime();
                            if (!Number.isFinite(tn)) return null;
                            return dn.toISOString();
                        }

                        // Normalize timezone offsets without colon: "+0000" -> "+00:00"
                        if (/[+-]\d{4}$/.test(s)) {
                            s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
                        }

                        // Some APIs return RFC3339 with >3 fractional digits (e.g. .123456Z).
                        // Normalize to milliseconds so Date.parse can understand it.
                        var m = s.match(
                            /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
                        );
                        if (m) {
                            var head = m[1];
                            var frac = m[2] || "";
                            var tz = m[3];
                            if (frac) {
                                var digits = frac.slice(1);
                                if (digits.length > 3) digits = digits.slice(0, 3);
                                while (digits.length < 3) digits = digits + "0";
                                frac = "." + digits;
                            }
                            s = head + frac + tz;
                        } else {
                            // ISO-like but missing timezone: assume UTC.
                            var mNoTz = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?$/);
                            if (mNoTz) {
                                var head2 = mNoTz[1];
                                var frac2 = mNoTz[2] || "";
                                if (frac2) {
                                    var digits2 = frac2.slice(1);
                                    if (digits2.length > 3) digits2 = digits2.slice(0, 3);
                                    while (digits2.length < 3) digits2 = digits2 + "0";
                                    frac2 = "." + digits2;
                                }
                                s = head2 + frac2 + "Z";
                            }
                        }

                        var parsed = Date.parse(s);
                        if (!Number.isFinite(parsed)) return null;
                        return new Date(parsed).toISOString();
                    }

                    if (typeof value === "number") {
                        if (!Number.isFinite(value)) return null;
                        var ms = Math.abs(value) < 1e10 ? value * 1000 : value;
                        var d = new Date(ms);
                        var t = d.getTime();
                        if (!Number.isFinite(t)) return null;
                        return d.toISOString();
                    }

                    if (value instanceof Date) {
                        var t = value.getTime();
                        if (!Number.isFinite(t)) return null;
                        return value.toISOString();
                    }

                    return null;
                },
                needsRefreshByExpiry: function(opts) {
                    if (!opts) return true;
                    if (opts.expiresAtMs === null || opts.expiresAtMs === undefined) return true;
                    var nowMs = Number(opts.nowMs);
                    var expiresAtMs = Number(opts.expiresAtMs);
                    var bufferMs = Number(opts.bufferMs);
                    if (!Number.isFinite(nowMs)) return true;
                    if (!Number.isFinite(expiresAtMs)) return true;
                    if (!Number.isFinite(bufferMs)) bufferMs = 0;
                    return nowMs + bufferMs >= expiresAtMs;
                }
            };

            // Base64
            var b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            ctx.base64 = {
                decode: function(str) {
                    str = str.replace(/-/g, "+").replace(/_/g, "/");
                    while (str.length % 4) str += "=";
                    str = str.replace(/=+$/, "");
                    var result = "";
                    var len = str.length;
                    var i = 0;
                    while (i < len) {
                        var remaining = len - i;
                        var a = b64chars.indexOf(str.charAt(i++));
                        var b = b64chars.indexOf(str.charAt(i++));
                        var c = remaining > 2 ? b64chars.indexOf(str.charAt(i++)) : 0;
                        var d = remaining > 3 ? b64chars.indexOf(str.charAt(i++)) : 0;
                        var n = (a << 18) | (b << 12) | (c << 6) | d;
                        result += String.fromCharCode((n >> 16) & 0xff);
                        if (remaining > 2) result += String.fromCharCode((n >> 8) & 0xff);
                        if (remaining > 3) result += String.fromCharCode(n & 0xff);
                    }
                    return result;
                },
                encode: function(str) {
                    var result = "";
                    var len = str.length;
                    var i = 0;
                    while (i < len) {
                        var chunkStart = i;
                        var a = str.charCodeAt(i++);
                        var b = i < len ? str.charCodeAt(i++) : 0;
                        var c = i < len ? str.charCodeAt(i++) : 0;
                        var bytesInChunk = i - chunkStart;
                        var n = (a << 16) | (b << 8) | c;
                        result += b64chars.charAt((n >> 18) & 63);
                        result += b64chars.charAt((n >> 12) & 63);
                        result += bytesInChunk < 2 ? "=" : b64chars.charAt((n >> 6) & 63);
                        result += bytesInChunk < 3 ? "=" : b64chars.charAt(n & 63);
                    }
                    return result;
                }
            };

            // JWT
            ctx.jwt = {
                decodePayload: function(token) {
                    try {
                        var parts = token.split(".");
                        if (parts.length !== 3) return null;
                        var decoded = ctx.base64.decode(parts[1]);
                        return JSON.parse(decoded);
                    } catch (e) {
                        return null;
                    }
                }
            };
        })();
        "#
        .as_bytes(),
    )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpReqParams {
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body_text: Option<String>,
    timeout_ms: Option<u64>,
    dangerously_ignore_tls: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpRespParams {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body_text: String,
}

// --- Language Server Discovery ---

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LsDiscoverOpts {
    process_name: String,
    markers: Vec<String>,
    csrf_flag: String,
    port_flag: Option<String>,
    extra_flags: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LsDiscoverResult {
    pid: i32,
    csrf: String,
    ports: Vec<i32>,
    extra: std::collections::HashMap<String, String>,
    extension_port: Option<i32>,
}

fn inject_ls<'js>(ctx: &Ctx<'js>, host: &Object<'js>, plugin_id: &str) -> rquickjs::Result<()> {
    let ls_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();

    ls_obj.set(
        "_discoverRaw",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, opts_json: String| -> rquickjs::Result<String> {
                let opts: LsDiscoverOpts = serde_json::from_str(&opts_json).map_err(|e| {
                    Exception::throw_message(&ctx_inner, &format!("invalid discover opts: {}", e))
                })?;

                log::info!(
                    "[plugin:{}] LS discover: processName={}, markers={:?}",
                    pid,
                    opts.process_name,
                    opts.markers
                );

                let ps_output = match std::process::Command::new("/bin/ps")
                    .args(["-ax", "-o", "pid=,command="])
                    .output()
                {
                    Ok(o) => o,
                    Err(e) => {
                        log::warn!("[plugin:{}] ps failed: {}", pid, e);
                        return Ok("null".to_string());
                    }
                };

                if !ps_output.status.success() {
                    log::warn!("[plugin:{}] ps returned non-zero", pid);
                    return Ok("null".to_string());
                }

                let ps_stdout = String::from_utf8_lossy(&ps_output.stdout);
                let process_name_lower = opts.process_name.to_lowercase();
                let markers_lower: Vec<String> = opts
                    .markers
                    .iter()
                    .map(|m| m.trim().to_lowercase())
                    .filter(|m| !m.is_empty())
                    .collect();

                // Find the target process. Marker patterns are Codeium-derived.
                // Matching priority:
                //   1. Exact --ide_name / --app_data_dir flag value (prevents
                //      "windsurf" matching "windsurf-next")
                //   2. Path substring (/<marker>/) as fallback when no flags found
                let mut candidates: Vec<(u8, i32, String)> = Vec::new();

                for line in ps_stdout.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    let mut parts = trimmed.splitn(2, char::is_whitespace);
                    let pid_str = match parts.next() {
                        Some(s) => s.trim(),
                        None => continue,
                    };
                    let command = match parts.next() {
                        Some(s) => s.trim(),
                        None => continue,
                    };

                    if !ls_command_matches_process(command, &process_name_lower) {
                        continue;
                    }

                    let Some(marker_rank) = ls_marker_rank(command, &markers_lower) else {
                        continue;
                    };

                    if let Ok(p) = pid_str.parse::<i32>() {
                        candidates.push((marker_rank, p, command.to_string()));
                    }
                }

                if candidates.is_empty() {
                    log::info!("[plugin:{}] LS process not found", pid);
                    return Ok("null".to_string());
                }

                let lsof_path = ["/usr/sbin/lsof", "/usr/bin/lsof"]
                    .iter()
                    .find(|p| std::path::Path::new(p).exists())
                    .copied();

                candidates.sort_by_key(|(marker_rank, _, _)| *marker_rank);
                for (_, process_pid, command) in candidates {
                    let csrf = if opts.csrf_flag.trim().is_empty() {
                        String::new()
                    } else {
                        match ls_extract_flag(&command, &opts.csrf_flag) {
                            Some(c) => c,
                            None => {
                                log::warn!("[plugin:{}] CSRF token not found in process args", pid);
                                continue;
                            }
                        }
                    };

                    let extension_port = opts.port_flag.as_ref().and_then(|flag| {
                        ls_extract_flag(&command, flag).and_then(|v| v.parse::<i32>().ok())
                    });

                    let mut extra = std::collections::HashMap::new();
                    if let Some(ref flags) = opts.extra_flags {
                        for flag in flags {
                            if let Some(val) = ls_extract_flag(&command, flag) {
                                let key = flag.trim_start_matches('-').to_string();
                                extra.insert(key, val);
                            }
                        }
                    }

                    let ports = if let Some(lsof) = lsof_path {
                        match std::process::Command::new(lsof)
                            .args([
                                "-nP",
                                "-iTCP",
                                "-sTCP:LISTEN",
                                "-a",
                                "-p",
                                &process_pid.to_string(),
                            ])
                            .output()
                        {
                            Ok(o) if o.status.success() => {
                                ls_parse_listening_ports(&String::from_utf8_lossy(&o.stdout))
                            }
                            Ok(_) => {
                                log::warn!("[plugin:{}] lsof returned non-zero", pid);
                                Vec::new()
                            }
                            Err(e) => {
                                log::warn!("[plugin:{}] lsof failed: {}", pid, e);
                                Vec::new()
                            }
                        }
                    } else {
                        log::warn!("[plugin:{}] lsof not found", pid);
                        Vec::new()
                    };

                    if ports.is_empty() && extension_port.is_none() {
                        log::warn!(
                            "[plugin:{}] no listening ports found for pid {}",
                            pid,
                            process_pid
                        );
                        continue;
                    }

                    log::info!(
                        "[plugin:{}] LS found: pid={}, ports={:?}, csrf=[REDACTED]",
                        pid,
                        process_pid,
                        ports
                    );

                    let result = LsDiscoverResult {
                        pid: process_pid,
                        csrf,
                        ports,
                        extra,
                        extension_port,
                    };

                    return serde_json::to_string(&result).map_err(|e| {
                        Exception::throw_message(&ctx_inner, &format!("serialize failed: {}", e))
                    });
                }

                Ok("null".to_string())
            },
        )?,
    )?;

    host.set("ls", ls_obj)?;
    Ok(())
}

pub fn patch_ls_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var rawFn = __openusage_ctx.host.ls._discoverRaw;
            __openusage_ctx.host.ls.discover = function(opts) {
                var optsJson;
                try { optsJson = JSON.stringify(opts); } catch (e) { return null; }
                var json = rawFn(optsJson);
                if (json === "null") return null;
                return JSON.parse(json);
            };
        })();
        "#
        .as_bytes(),
    )
}

/// Extract value of a CLI flag from a command string.
/// Handles both `--flag value` and `--flag=value` forms.
fn ls_extract_flag(command: &str, flag: &str) -> Option<String> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    let flag_eq = format!("{}=", flag);
    for (i, part) in parts.iter().enumerate() {
        if *part == flag {
            if i + 1 < parts.len() {
                return Some(parts[i + 1].to_string());
            }
        } else if part.starts_with(&flag_eq) {
            return Some(part[flag_eq.len()..].to_string());
        }
    }
    None
}

fn ls_marker_rank(command: &str, markers_lower: &[String]) -> Option<u8> {
    if markers_lower.is_empty() {
        return Some(0);
    }

    let ide_name = ls_extract_flag(command, "--ide_name").map(|v| v.to_lowercase());
    let app_data = ls_extract_flag(command, "--app_data_dir").map(|v| v.to_lowercase());
    if ide_name.is_some() || app_data.is_some() {
        return markers_lower
            .iter()
            .any(|m| {
                ide_name.as_ref().is_some_and(|name| name == m)
                    || app_data.as_ref().is_some_and(|dir| dir == m)
            })
            .then_some(0);
    }

    let command_lower = command.to_lowercase();
    markers_lower
        .iter()
        .any(|m| command_lower.contains(&format!("/{}/", m)))
        .then_some(1)
}

fn ls_argv0(command: &str) -> &str {
    let trimmed = command.trim_start();
    let Some(quote) = trimmed.chars().next().filter(|c| *c == '"' || *c == '\'') else {
        return trimmed.split_whitespace().next().unwrap_or_default();
    };

    let quote_len = quote.len_utf8();
    let rest = &trimmed[quote_len..];
    match rest.find(quote) {
        Some(end) => &rest[..end],
        None => trimmed.split_whitespace().next().unwrap_or_default(),
    }
}

fn ls_command_matches_process(command: &str, process_name_lower: &str) -> bool {
    if process_name_lower.is_empty() {
        return false;
    }

    let argv0 = ls_argv0(command);
    let exe_name = Path::new(argv0)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_lowercase())
        .unwrap_or_default();

    if exe_name == process_name_lower {
        return true;
    }

    if process_name_lower.len() >= 8 {
        exe_name.starts_with(&format!("{}_", process_name_lower))
            || command.to_lowercase().contains(process_name_lower)
    } else {
        let command_lower = command.to_lowercase();
        command_lower.ends_with(&format!("/{}", process_name_lower))
            || command_lower.contains(&format!("/{} ", process_name_lower))
            || command_lower.contains(&format!("/{}\t", process_name_lower))
    }
}

/// Parse listening port numbers from `lsof -nP -iTCP -sTCP:LISTEN` output.
fn ls_parse_listening_ports(output: &str) -> Vec<i32> {
    let mut ports = std::collections::BTreeSet::new();
    for line in output.lines() {
        if !line.contains("LISTEN") {
            continue;
        }
        // lsof -nP output: ... TCP 127.0.0.1:PORT (LISTEN)  or  ... TCP *:PORT
        // Scan tokens in reverse to find the address:port token.
        for token in line.split_whitespace().rev() {
            if let Some(colon_pos) = token.rfind(':') {
                let port_str = &token[colon_pos + 1..];
                if let Ok(port) = port_str.parse::<i32>() {
                    if port > 0 && port < 65536 {
                        ports.insert(port);
                        break;
                    }
                }
            }
        }
    }
    ports.into_iter().collect()
}

const CCUSAGE_VERSION: &str = "20.0.20";
const CCUSAGE_PACKAGE_NAME: &str = "ccusage";
const CCUSAGE_BIN_NAME: &str = "ccusage";
const CCUSAGE_LEGACY_VERSION: &str = "18.0.11";
const CCUSAGE_LEGACY_CLAUDE_PACKAGE_NAME: &str = "ccusage";
const CCUSAGE_LEGACY_CODEX_PACKAGE_NAME: &str = "@ccusage/codex";
const CCUSAGE_LEGACY_CODEX_BIN_NAME: &str = "ccusage-codex";
const CCUSAGE_TIMEOUT_SECS: u64 = 15;
const CCUSAGE_POLL_INTERVAL_MS: u64 = 100;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcusageQueryOpts {
    provider: Option<String>,
    since: Option<String>,
    until: Option<String>,
    home_path: Option<String>,
    claude_path: Option<String>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
enum CcusageProvider {
    Claude,
    Codex,
}

static CCUSAGE_ACTIVE_PROVIDERS: OnceLock<Mutex<HashSet<CcusageProvider>>> = OnceLock::new();

struct CcusageQueryGuard {
    provider: CcusageProvider,
}

impl CcusageQueryGuard {
    fn acquire(provider: CcusageProvider) -> Option<Self> {
        let active = CCUSAGE_ACTIVE_PROVIDERS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = active.lock().unwrap_or_else(|err| err.into_inner());
        if !active.insert(provider) {
            return None;
        }
        Some(Self { provider })
    }
}

impl Drop for CcusageQueryGuard {
    fn drop(&mut self) {
        let active = CCUSAGE_ACTIVE_PROVIDERS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = active.lock().unwrap_or_else(|err| err.into_inner());
        active.remove(&self.provider);
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum CcusageRunnerKind {
    Bunx,
    PnpmDlx,
    YarnDlx,
    NpmExec,
    Npx,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum CcusageCommandFlavor {
    Current,
    Legacy,
}

fn ccusage_runner_order() -> [CcusageRunnerKind; 5] {
    [
        CcusageRunnerKind::Bunx,
        CcusageRunnerKind::PnpmDlx,
        CcusageRunnerKind::YarnDlx,
        CcusageRunnerKind::NpmExec,
        CcusageRunnerKind::Npx,
    ]
}

fn ccusage_runner_label(kind: CcusageRunnerKind) -> &'static str {
    match kind {
        CcusageRunnerKind::Bunx => "bunx",
        CcusageRunnerKind::PnpmDlx => "pnpm dlx",
        CcusageRunnerKind::YarnDlx => "yarn dlx",
        CcusageRunnerKind::NpmExec => "npm exec",
        CcusageRunnerKind::Npx => "npx",
    }
}

#[derive(Copy, Clone)]
struct CcusageProviderConfig {
    command_namespace: &'static str,
    home_env_var: &'static str,
}

fn parse_ccusage_provider(value: &str) -> Option<CcusageProvider> {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(CcusageProvider::Claude),
        "codex" => Some(CcusageProvider::Codex),
        _ => None,
    }
}

fn infer_ccusage_provider(plugin_id: &str) -> Option<CcusageProvider> {
    parse_ccusage_provider(plugin_id)
}

fn resolve_ccusage_provider(opts: &CcusageQueryOpts, plugin_id: &str) -> CcusageProvider {
    opts.provider
        .as_deref()
        .and_then(parse_ccusage_provider)
        .or_else(|| infer_ccusage_provider(plugin_id))
        .unwrap_or(CcusageProvider::Claude)
}

fn ccusage_provider_config(provider: CcusageProvider) -> CcusageProviderConfig {
    match provider {
        CcusageProvider::Claude => CcusageProviderConfig {
            command_namespace: "claude",
            home_env_var: "CLAUDE_CONFIG_DIR",
        },
        CcusageProvider::Codex => CcusageProviderConfig {
            command_namespace: "codex",
            home_env_var: "CODEX_HOME",
        },
    }
}

fn ccusage_package_spec() -> String {
    format!("{}@{}", CCUSAGE_PACKAGE_NAME, CCUSAGE_VERSION)
}

fn ccusage_legacy_package_spec(provider: CcusageProvider) -> String {
    let package_name = match provider {
        CcusageProvider::Claude => CCUSAGE_LEGACY_CLAUDE_PACKAGE_NAME,
        CcusageProvider::Codex => CCUSAGE_LEGACY_CODEX_PACKAGE_NAME,
    };
    format!("{}@{}", package_name, CCUSAGE_LEGACY_VERSION)
}

fn ccusage_home_override<'a>(
    opts: &'a CcusageQueryOpts,
    provider: CcusageProvider,
) -> Option<&'a str> {
    if let Some(home_path) = opts
        .home_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(home_path);
    }

    match provider {
        CcusageProvider::Claude => opts
            .claude_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        CcusageProvider::Codex => None,
    }
}

fn ccusage_runner_candidates(kind: CcusageRunnerKind) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    match kind {
        CcusageRunnerKind::Bunx => {
            if let Some(home) = dirs::home_dir() {
                candidates.push(home.join(".bun/bin/bunx").to_string_lossy().to_string());
            }
            candidates.extend(
                ["/opt/homebrew/bin/bunx", "/usr/local/bin/bunx", "bunx"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::PnpmDlx => {
            candidates.extend(
                ["/opt/homebrew/bin/pnpm", "/usr/local/bin/pnpm", "pnpm"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::YarnDlx => {
            candidates.extend(
                ["/opt/homebrew/bin/yarn", "/usr/local/bin/yarn", "yarn"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::NpmExec => {
            candidates.extend(
                ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "npm"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        CcusageRunnerKind::Npx => {
            candidates.extend(
                ["/opt/homebrew/bin/npx", "/usr/local/bin/npx", "npx"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
    }

    let mut unique = Vec::new();
    for candidate in candidates {
        if candidate.is_empty() || unique.iter().any(|c| c == &candidate) {
            continue;
        }
        unique.push(candidate);
    }
    unique
}

fn nvm_default_bin_path(home: &Path) -> Option<PathBuf> {
    let alias_path = home.join(".nvm/alias/default");
    let version = std::fs::read_to_string(&alias_path).ok()?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    let version = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    Some(home.join(".nvm/versions/node").join(version).join("bin"))
}

fn ccusage_path_entries_with(home: Option<&Path>, existing_path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = Vec::new();

    if let Some(home) = home {
        entries.push(home.join(".bun/bin"));
        entries.push(home.join(".nvm/current/bin"));
        if let Some(nvm_bin) = nvm_default_bin_path(home) {
            entries.push(nvm_bin);
        }
        entries.push(home.join(".local/bin"));
    }

    entries.extend(
        ["/opt/homebrew/bin", "/usr/local/bin"]
            .into_iter()
            .map(PathBuf::from),
    );

    if let Some(existing_path) = existing_path {
        for path in std::env::split_paths(existing_path) {
            entries.push(path);
        }
    }

    let mut unique_entries = Vec::new();
    for entry in entries {
        if entry.as_os_str().is_empty() || unique_entries.iter().any(|path| path == &entry) {
            continue;
        }
        unique_entries.push(entry);
    }
    unique_entries
}

fn ccusage_enriched_path_with(
    home: Option<&Path>,
    existing_path: Option<&OsStr>,
) -> Option<OsString> {
    let entries = ccusage_path_entries_with(home, existing_path);
    if entries.is_empty() {
        return None;
    }
    std::env::join_paths(entries).ok()
}

fn ccusage_enriched_path() -> Option<OsString> {
    let home = dirs::home_dir();
    let existing_path = std::env::var_os("PATH");
    ccusage_enriched_path_with(home.as_deref(), existing_path.as_deref())
}

fn ccusage_runner_available(candidate: &str, enriched_path: Option<&OsStr>) -> bool {
    let mut command = std::process::Command::new(candidate);
    command.arg("--version");
    if let Some(path) = enriched_path {
        command.env("PATH", path);
    }
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    command.status().map(|s| s.success()).unwrap_or(false)
}

fn configure_ccusage_command(
    command: &mut std::process::Command,
    args: &[String],
    enriched_path: Option<&OsStr>,
) {
    command.args(args);
    if let Some(path) = enriched_path {
        command.env("PATH", path);
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn resolve_ccusage_runner_binary(kind: CcusageRunnerKind) -> Option<String> {
    let path = ccusage_enriched_path();
    for candidate in ccusage_runner_candidates(kind) {
        if ccusage_runner_available(&candidate, path.as_deref()) {
            return Some(candidate);
        }
    }
    None
}

fn collect_ccusage_runners_with<F>(mut resolver: F) -> Vec<(CcusageRunnerKind, String)>
where
    F: FnMut(CcusageRunnerKind) -> Option<String>,
{
    let mut runners = Vec::new();
    for kind in ccusage_runner_order() {
        if let Some(program) = resolver(kind) {
            runners.push((kind, program));
        }
    }
    runners
}

fn collect_ccusage_runners() -> Vec<(CcusageRunnerKind, String)> {
    collect_ccusage_runners_with(resolve_ccusage_runner_binary)
}

fn append_ccusage_common_args(
    args: &mut Vec<String>,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    flavor: CcusageCommandFlavor,
) {
    let config = ccusage_provider_config(provider);
    if flavor == CcusageCommandFlavor::Current {
        args.push(config.command_namespace.to_string());
    }
    args.extend([
        "daily".to_string(),
        "--json".to_string(),
        "--order".to_string(),
        "desc".to_string(),
    ]);

    if let Some(since) = opts
        .since
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("--since".to_string());
        args.push(since.to_string());
    }

    if let Some(until) = opts
        .until
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("--until".to_string());
        args.push(until.to_string());
    }
}

fn ccusage_runner_args(
    kind: CcusageRunnerKind,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    flavor: CcusageCommandFlavor,
) -> Vec<String> {
    let package_spec = match flavor {
        CcusageCommandFlavor::Current => ccusage_package_spec(),
        CcusageCommandFlavor::Legacy => ccusage_legacy_package_spec(provider),
    };
    let npm_exec_bin = match (flavor, provider) {
        (CcusageCommandFlavor::Current, _) => CCUSAGE_BIN_NAME,
        (CcusageCommandFlavor::Legacy, CcusageProvider::Claude) => CCUSAGE_BIN_NAME,
        (CcusageCommandFlavor::Legacy, CcusageProvider::Codex) => CCUSAGE_LEGACY_CODEX_BIN_NAME,
    };
    let mut args: Vec<String> = match kind {
        CcusageRunnerKind::Bunx => vec!["--silent".to_string(), package_spec.clone()],
        CcusageRunnerKind::PnpmDlx => {
            vec!["-s".to_string(), "dlx".to_string(), package_spec.clone()]
        }
        CcusageRunnerKind::YarnDlx => {
            vec!["dlx".to_string(), "-q".to_string(), package_spec.clone()]
        }
        CcusageRunnerKind::NpmExec => vec![
            "exec".to_string(),
            "--yes".to_string(),
            format!("--package={package_spec}"),
            "--".to_string(),
            npm_exec_bin.to_string(),
        ],
        CcusageRunnerKind::Npx => vec!["--yes".to_string(), package_spec],
    };

    append_ccusage_common_args(&mut args, opts, provider, flavor);
    args
}

fn extract_last_json_value(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }

    if serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        return Some(trimmed.to_string());
    }

    let mut starts: Vec<usize> = trimmed
        .char_indices()
        .filter(|(_, c)| *c == '{' || *c == '[')
        .map(|(idx, _)| idx)
        .collect();
    starts.reverse();

    for start in starts {
        let candidate = trimmed[start..].trim();
        if serde_json::from_str::<serde_json::Value>(candidate).is_ok() {
            return Some(candidate.to_string());
        }
    }

    None
}

fn normalize_ccusage_output(stdout: &str) -> Option<String> {
    let json_value = extract_last_json_value(stdout)?;
    let parsed: serde_json::Value = serde_json::from_str(&json_value).ok()?;

    let normalized = match parsed {
        serde_json::Value::Array(daily) => serde_json::json!({ "daily": daily }),
        serde_json::Value::Object(map) => {
            let daily = map.get("daily")?;
            if !daily.is_array() {
                return None;
            }
            serde_json::Value::Object(map)
        }
        _ => return None,
    };

    serde_json::to_string(&normalized).ok()
}

#[derive(Debug, Eq, PartialEq)]
enum CcusageRunnerResult {
    Success(String),
    Failed,
    TimedOut,
}

#[cfg(unix)]
fn kill_ccusage_process_group(child_id: u32) -> std::io::Result<()> {
    let pgid = i32::try_from(child_id)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid child pid"))?;
    let rc = unsafe { libc::kill(-pgid, libc::SIGKILL) };
    if rc == 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(err)
}

fn kill_ccusage_on_timeout(child: &mut std::process::Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        kill_ccusage_process_group(child.id())
    }

    #[cfg(not(unix))]
    {
        child.kill()
    }
}

fn format_ccusage_timeout(timeout: std::time::Duration) -> String {
    if timeout.subsec_millis() == 0 {
        return format!("{}s", timeout.as_secs());
    }
    if timeout.as_secs() == 0 {
        return format!("{}ms", timeout.as_millis());
    }
    format!("{:.3}s", timeout.as_secs_f64())
}

#[cfg(test)]
fn run_ccusage_with_runner(
    kind: CcusageRunnerKind,
    program: &str,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
) -> CcusageRunnerResult {
    run_ccusage_with_runner_deadline(
        kind,
        program,
        opts,
        provider,
        plugin_id,
        ProbeDeadline::none(),
    )
}

fn run_ccusage_with_runner_deadline(
    kind: CcusageRunnerKind,
    program: &str,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> CcusageRunnerResult {
    if deadline.has_elapsed() {
        log::warn!("[plugin:{}] ccusage skipped: probe timed out", plugin_id);
        return CcusageRunnerResult::TimedOut;
    }

    let Some(current_timeout) = deadline.clamp_duration(Duration::from_secs(CCUSAGE_TIMEOUT_SECS))
    else {
        log_probe_deadline_skip(plugin_id, "ccusage");
        return CcusageRunnerResult::TimedOut;
    };

    let current = run_ccusage_with_runner_timeout(
        kind,
        program,
        opts,
        provider,
        plugin_id,
        CcusageCommandFlavor::Current,
        current_timeout,
    );
    match current {
        CcusageRunnerResult::Failed if deadline.has_elapsed() => CcusageRunnerResult::TimedOut,
        CcusageRunnerResult::Failed => {
            let Some(legacy_timeout) =
                deadline.clamp_duration(Duration::from_secs(CCUSAGE_TIMEOUT_SECS))
            else {
                log_probe_deadline_skip(plugin_id, "ccusage legacy fallback");
                return CcusageRunnerResult::TimedOut;
            };
            run_ccusage_with_runner_timeout(
                kind,
                program,
                opts,
                provider,
                plugin_id,
                CcusageCommandFlavor::Legacy,
                legacy_timeout,
            )
        }
        other => other,
    }
}

fn run_ccusage_with_runner_timeout(
    kind: CcusageRunnerKind,
    program: &str,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
    flavor: CcusageCommandFlavor,
    timeout: std::time::Duration,
) -> CcusageRunnerResult {
    let args = ccusage_runner_args(kind, opts, provider, flavor);
    let enriched_path = ccusage_enriched_path();
    let mut command = std::process::Command::new(program);
    configure_ccusage_command(&mut command, &args, enriched_path.as_deref());

    if let Some(home_path) = ccusage_home_override(opts, provider) {
        let config = ccusage_provider_config(provider);
        command.env(config.home_env_var, expand_path(&home_path));
    }

    let redacted_program = redact_log_message(program);

    log::info!(
        "[plugin:{}] ccusage query via {} {:?} ({})",
        plugin_id,
        ccusage_runner_label(kind),
        flavor,
        redacted_program
    );

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "[plugin:{}] ccusage spawn failed for {}: {}",
                plugin_id,
                ccusage_runner_label(kind),
                e
            );
            return CcusageRunnerResult::Failed;
        }
    };

    // Drain pipes concurrently while the process is running so the child cannot block on full
    // stdout/stderr buffers before exit.
    let mut stdout_reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stdout, &mut v);
            v
        })
    });
    let mut stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stderr, &mut v);
            v
        })
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader
                    .take()
                    .and_then(|reader| reader.join().ok())
                    .unwrap_or_default();
                let stderr = stderr_reader
                    .take()
                    .and_then(|reader| reader.join().ok())
                    .unwrap_or_default();

                if status.success() {
                    let out = String::from_utf8_lossy(&stdout);
                    if let Some(normalized_json) = normalize_ccusage_output(&out) {
                        return CcusageRunnerResult::Success(normalized_json);
                    }
                    log::warn!(
                        "[plugin:{}] ccusage output parse failed for {}",
                        plugin_id,
                        ccusage_runner_label(kind)
                    );
                    return CcusageRunnerResult::Failed;
                }

                let err = String::from_utf8_lossy(&stderr);
                log::warn!(
                    "[plugin:{}] ccusage failed for {}: {}",
                    plugin_id,
                    ccusage_runner_label(kind),
                    err.trim()
                );
                return CcusageRunnerResult::Failed;
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    if let Err(e) = kill_ccusage_on_timeout(&mut child) {
                        log::warn!(
                            "[plugin:{}] ccusage process group kill failed for {}: {}",
                            plugin_id,
                            ccusage_runner_label(kind),
                            e
                        );
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                    let _ = stdout_reader.take().and_then(|reader| reader.join().ok());
                    let _ = stderr_reader.take().and_then(|reader| reader.join().ok());
                    log::warn!(
                        "[plugin:{}] ccusage timed out after {} for {}",
                        plugin_id,
                        format_ccusage_timeout(timeout),
                        ccusage_runner_label(kind)
                    );
                    return CcusageRunnerResult::TimedOut;
                }
                std::thread::sleep(std::time::Duration::from_millis(CCUSAGE_POLL_INTERVAL_MS));
            }
            Err(e) => {
                log::warn!(
                    "[plugin:{}] ccusage wait failed for {}: {}",
                    plugin_id,
                    ccusage_runner_label(kind),
                    e
                );
                return CcusageRunnerResult::Failed;
            }
        }
    }
}

fn run_ccusage_query_with_runners<F>(
    runners: Vec<(CcusageRunnerKind, String)>,
    opts: &CcusageQueryOpts,
    provider: CcusageProvider,
    plugin_id: &str,
    mut run: F,
) -> String
where
    F: FnMut(
        CcusageRunnerKind,
        &str,
        &CcusageQueryOpts,
        CcusageProvider,
        &str,
    ) -> CcusageRunnerResult,
{
    if runners.is_empty() {
        log::warn!(
            "[plugin:{}] no package runner found for ccusage query",
            plugin_id
        );
        return serde_json::json!({ "status": "no_runner" }).to_string();
    }

    for (kind, program) in runners {
        match run(kind, &program, opts, provider, plugin_id) {
            CcusageRunnerResult::Success(result) => {
                let data: serde_json::Value = match serde_json::from_str(&result) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!(
                            "[plugin:{}] ccusage normalized payload parse failed: {}",
                            plugin_id,
                            e
                        );
                        continue;
                    }
                };
                return serde_json::json!({ "status": "ok", "data": data }).to_string();
            }
            CcusageRunnerResult::Failed => {}
            CcusageRunnerResult::TimedOut => {
                log::warn!(
                    "[plugin:{}] ccusage query timed out; skipping fallback runners",
                    plugin_id
                );
                return serde_json::json!({ "status": "runner_failed" }).to_string();
            }
        }
    }

    log::warn!(
        "[plugin:{}] ccusage query failed with all available runners",
        plugin_id
    );
    serde_json::json!({ "status": "runner_failed" }).to_string()
}

fn inject_ccusage<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let ccusage_obj = Object::new(ctx.clone())?;
    let pid = plugin_id.to_string();

    ccusage_obj.set(
        "_queryRaw",
        Function::new(
            ctx.clone(),
            move |_ctx_inner: Ctx<'_>, opts_json: String| -> rquickjs::Result<String> {
                let opts: CcusageQueryOpts = match serde_json::from_str(&opts_json) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[plugin:{}] invalid ccusage opts JSON: {}", pid, e);
                        CcusageQueryOpts::default()
                    }
                };
                let provider = resolve_ccusage_provider(&opts, &pid);
                let Some(_active_query) = CcusageQueryGuard::acquire(provider) else {
                    log::warn!("[plugin:{}] ccusage query already running", pid);
                    return Ok(serde_json::json!({ "status": "runner_failed" }).to_string());
                };
                let runners = collect_ccusage_runners();
                Ok(run_ccusage_query_with_runners(
                    runners,
                    &opts,
                    provider,
                    &pid,
                    |kind, program, opts, provider, plugin_id| {
                        run_ccusage_with_runner_deadline(
                            kind, program, opts, provider, plugin_id, deadline,
                        )
                    },
                ))
            },
        )?,
    )?;

    host.set("ccusage", ccusage_obj)?;
    Ok(())
}

pub fn patch_ccusage_wrapper(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var rawFn = __openusage_ctx.host.ccusage._queryRaw;
            __openusage_ctx.host.ccusage.query = function(opts) {
                var result = rawFn(JSON.stringify(opts || {}));
                try {
                    var parsed = JSON.parse(result);
                    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
                        return parsed;
                    }
                } catch (e) {}
                return { status: "runner_failed" };
            };
        })();
        "#
        .as_bytes(),
    )
}

fn inject_keychain<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
) -> rquickjs::Result<()> {
    let keychain_obj = Object::new(ctx.clone())?;
    let pid_read = plugin_id.to_string();

    keychain_obj.set(
        "readGenericPassword",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  service: String,
                  account_args: Rest<Option<String>>|
                  -> rquickjs::Result<String> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = account_args
                    .0
                    .into_iter()
                    .next()
                    .flatten()
                    .and_then(|value| {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    });
                let redacted_account = account.as_ref().map(|value| redact_value(value));
                if let Some(ref redacted) = redacted_account {
                    log::info!(
                        "[plugin:{}] keychain read: service={}, account={}",
                        pid_read,
                        service,
                        redacted
                    );
                } else {
                    log::info!("[plugin:{}] keychain read: service={}", pid_read, service);
                }
                let args = if let Some(ref account) = account {
                    keychain_find_generic_password_args_for_account(&service, account)
                } else {
                    keychain_find_generic_password_args(&service)
                };
                let output = std::process::Command::new("security")
                    .args(args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain read failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    if let Some(ref redacted) = redacted_account {
                        log::warn!(
                            "[plugin:{}] keychain read miss: service={}, account={}, error={}",
                            pid_read,
                            service,
                            redacted,
                            first_line
                        );
                    } else {
                        log::warn!(
                            "[plugin:{}] keychain read miss: service={}, error={}",
                            pid_read,
                            service,
                            first_line
                        );
                    }
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain item not found: {}", first_line),
                    ));
                }

                if let Some(ref redacted) = redacted_account {
                    log::info!(
                        "[plugin:{}] keychain read hit: service={}, account={}",
                        pid_read,
                        service,
                        redacted
                    );
                } else {
                    log::info!(
                        "[plugin:{}] keychain read hit: service={}",
                        pid_read,
                        service
                    );
                }
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            },
        )?,
    )?;

    let pid_read_current_user = plugin_id.to_string();
    keychain_obj.set(
        "readGenericPasswordForCurrentUser",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, service: String| -> rquickjs::Result<String> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = current_macos_keychain_account();
                let args = keychain_find_generic_password_args_for_account(&service, &account);
                let redacted_account = redact_value(&account);
                log::info!(
                    "[plugin:{}] keychain read: service={}, account={}",
                    pid_read_current_user,
                    service,
                    redacted_account
                );
                let output = std::process::Command::new("security")
                    .args(&args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain read failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    log::warn!(
                        "[plugin:{}] keychain read miss: service={}, account={}, error={}",
                        pid_read_current_user,
                        service,
                        redacted_account,
                        first_line
                    );
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain item not found: {}", first_line),
                    ));
                }

                log::info!(
                    "[plugin:{}] keychain read hit: service={}, account={}",
                    pid_read_current_user,
                    service,
                    redacted_account
                );
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            },
        )?,
    )?;

    let pid_write = plugin_id.to_string();
    keychain_obj.set(
        "writeGenericPassword",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, service: String, value: String| -> rquickjs::Result<()> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                log::info!("[plugin:{}] keychain write: service={}", pid_write, service);

                let mut account_arg: Option<String> = None;
                let find_output = std::process::Command::new("security")
                    .args(["find-generic-password", "-s", &service])
                    .output();

                if let Ok(output) = find_output {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        for line in stdout.lines() {
                            if let Some(start) = line.find("\"acct\"<blob>=\"") {
                                let rest = &line[start + 14..];
                                if let Some(end) = rest.find('"') {
                                    account_arg = Some(rest[..end].to_string());
                                    break;
                                }
                            }
                        }
                    }
                }

                let output = if let Some(ref acct) = account_arg {
                    std::process::Command::new("security")
                        .args(keychain_add_generic_password_args_for_account(
                            &service, acct, &value,
                        ))
                        .output()
                } else {
                    std::process::Command::new("security")
                        .args(keychain_add_generic_password_args(&service, &value))
                        .output()
                }
                .map_err(|e| {
                    Exception::throw_message(&ctx_inner, &format!("keychain write failed: {}", e))
                })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    log::warn!(
                        "[plugin:{}] keychain write failed: service={}, error={}",
                        pid_write,
                        service,
                        first_line
                    );
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain write failed: {}", first_line),
                    ));
                }

                log::info!(
                    "[plugin:{}] keychain write succeeded: service={}",
                    pid_write,
                    service
                );
                Ok(())
            },
        )?,
    )?;

    let pid_write_current_user = plugin_id.to_string();
    keychain_obj.set(
        "writeGenericPasswordForCurrentUser",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, service: String, value: String| -> rquickjs::Result<()> {
                if !cfg!(target_os = "macos") {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "keychain API is only supported on macOS",
                    ));
                }
                let account = current_macos_keychain_account();
                let args =
                    keychain_add_generic_password_args_for_account(&service, &account, &value);
                let redacted_account = redact_value(&account);
                log::info!(
                    "[plugin:{}] keychain write: service={}, account={}",
                    pid_write_current_user,
                    service,
                    redacted_account
                );
                let output = std::process::Command::new("security")
                    .args(&args)
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(
                            &ctx_inner,
                            &format!("keychain write failed: {}", e),
                        )
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first_line = stderr.lines().next().unwrap_or("").trim();
                    log::warn!(
                        "[plugin:{}] keychain write failed: service={}, account={}, error={}",
                        pid_write_current_user,
                        service,
                        redacted_account,
                        first_line
                    );
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("keychain write failed: {}", first_line),
                    ));
                }

                log::info!(
                    "[plugin:{}] keychain write succeeded: service={}, account={}",
                    pid_write_current_user,
                    service,
                    redacted_account
                );
                Ok(())
            },
        )?,
    )?;

    host.set("keychain", keychain_obj)?;
    Ok(())
}

fn inject_sqlite<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    let sqlite_obj = Object::new(ctx.clone())?;

    sqlite_obj.set(
        "query",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, db_path: String, sql: String| -> rquickjs::Result<String> {
                if sql.lines().any(|line| line.trim_start().starts_with('.')) {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "sqlite3 dot-commands are not allowed",
                    ));
                }
                let expanded = expand_path(&db_path);

                // Prefer a normal read-only open so WAL contents are visible (common for app state DBs).
                // Fall back to immutable=1 to bypass WAL/SHM lock issues after macOS sleep.
                let primary = std::process::Command::new("sqlite3")
                    .args(["-readonly", "-json", &expanded, &sql])
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(&ctx_inner, &format!("sqlite3 exec failed: {}", e))
                    })?;

                if primary.status.success() {
                    return Ok(String::from_utf8_lossy(&primary.stdout).to_string());
                }

                // Percent-encode special chars for valid URI (% must be first!)
                let encoded = expanded
                    .replace('%', "%25")
                    .replace(' ', "%20")
                    .replace('#', "%23")
                    .replace('?', "%3F");
                let uri_path = format!("file:{}?immutable=1", encoded);
                let fallback = std::process::Command::new("sqlite3")
                    .args(["-readonly", "-json", &uri_path, &sql])
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(&ctx_inner, &format!("sqlite3 exec failed: {}", e))
                    })?;

                if !fallback.status.success() {
                    let stderr_primary = String::from_utf8_lossy(&primary.stderr);
                    let stderr_fallback = String::from_utf8_lossy(&fallback.stderr);
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!(
                            "sqlite3 error: {} (fallback: {})",
                            stderr_primary.trim(),
                            stderr_fallback.trim()
                        ),
                    ));
                }

                Ok(String::from_utf8_lossy(&fallback.stdout).to_string())
            },
        )?,
    )?;

    sqlite_obj.set(
        "exec",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>, db_path: String, sql: String| -> rquickjs::Result<()> {
                if sql.lines().any(|line| line.trim_start().starts_with('.')) {
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        "sqlite3 dot-commands are not allowed",
                    ));
                }
                let expanded = expand_path(&db_path);
                let output = std::process::Command::new("sqlite3")
                    .args([&expanded, &sql])
                    .output()
                    .map_err(|e| {
                        Exception::throw_message(&ctx_inner, &format!("sqlite3 exec failed: {}", e))
                    })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(Exception::throw_message(
                        &ctx_inner,
                        &format!("sqlite3 error: {}", stderr.trim()),
                    ));
                }

                Ok(())
            },
        )?,
    )?;

    host.set("sqlite", sqlite_obj)?;
    Ok(())
}

fn iso_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|err| {
            log::error!("nowIso format failed: {}", err);
            "1970-01-01T00:00:00Z".to_string()
        })
}

fn expand_path(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

#[cfg(test)]
#[path = "host_api_proxy_tests.rs"]
mod proxy_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Function, Object, Runtime};
    use serial_test::serial;

    fn encrypt_aes_256_gcm_envelope_for_test(key: &[u8], plaintext: &str) -> String {
        let iv = [7_u8; 16];
        type Aes256Gcm16 = AesGcm<Aes256, U16>;
        let cipher = Aes256Gcm16::new_from_slice(key).expect("encrypt init");
        let nonce = Nonce::<U16>::from_slice(&iv);
        let ciphertext_and_tag = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .expect("encrypt finalize");
        let split_at = ciphertext_and_tag.len() - 16;
        let (ciphertext, tag) = ciphertext_and_tag.split_at(split_at);

        format!(
            "{}:{}:{}",
            BASE64_STANDARD.encode(iv),
            BASE64_STANDARD.encode(tag),
            BASE64_STANDARD.encode(ciphertext)
        )
    }

    fn node_generated_aes_256_gcm_vector_for_test() -> (&'static str, &'static str, &'static str) {
        (
            "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=",
            "BwcHBwcHBwcHBwcHBwcHBw==:yFbCs4LOJ0aj9NPNf5pfVA==:7PKjtOdATLClvaWrMw0b0M8Nov4KPhxwQX4hdczqQlcZi9Zhi6DjAoK+WolvMwuhPIk=",
            r#"{"access_token":"token","refresh_token":"refresh"}"#,
        )
    }

    #[test]
    fn last_non_empty_trimmed_line_uses_final_value_when_stdout_is_noisy() {
        let stdout = "banner line\nanother message\n  sk-test-key-12345  \n";
        let value = last_non_empty_trimmed_line(stdout);
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn last_non_empty_trimmed_line_returns_none_for_empty_stdout() {
        let stdout = "  \n\n\t\n";
        let value = last_non_empty_trimmed_line(stdout);
        assert!(value.is_none());
    }

    #[test]
    fn decrypt_aes_256_gcm_envelope_round_trips_plaintext() {
        let key = [11_u8; 32];
        let key_b64 = BASE64_STANDARD.encode(key);
        let plaintext = r#"{"access_token":"token","refresh_token":"refresh"}"#;
        let envelope = encrypt_aes_256_gcm_envelope_for_test(&key, plaintext);

        let decrypted =
            decrypt_aes_256_gcm_envelope(&envelope, &key_b64).expect("decrypt envelope");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_aes_256_gcm_envelope_round_trips_plaintext() {
        let key = [21_u8; 32];
        let key_b64 = BASE64_STANDARD.encode(key);
        let plaintext = r#"{"access_token":"token-2","refresh_token":"refresh-2"}"#;

        let envelope = encrypt_aes_256_gcm_envelope(plaintext, &key_b64).expect("encrypt envelope");
        let decrypted =
            decrypt_aes_256_gcm_envelope(&envelope, &key_b64).expect("decrypt envelope");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_aes_256_gcm_envelope_rejects_invalid_component_lengths() {
        let key_b64 = BASE64_STANDARD.encode([9_u8; 32]);
        let short_key_b64 = BASE64_STANDARD.encode([7_u8; 31]);
        let iv_b64 = BASE64_STANDARD.encode([1_u8; 15]);
        let tag_b64 = BASE64_STANDARD.encode([2_u8; 16]);
        let ciphertext_b64 = BASE64_STANDARD.encode([3_u8; 8]);

        let key_err =
            decrypt_aes_256_gcm_envelope("AQ==:AQ==:AQ==", &short_key_b64).expect_err("key length");
        assert!(key_err.contains("expected 32 bytes"));

        let iv_err = decrypt_aes_256_gcm_envelope(
            &format!("{}:{}:{}", iv_b64, tag_b64, ciphertext_b64),
            &key_b64,
        )
        .expect_err("iv length");
        assert!(iv_err.contains("iv length"));

        let short_tag_b64 = BASE64_STANDARD.encode([2_u8; 15]);
        let tag_err = decrypt_aes_256_gcm_envelope(
            &format!(
                "{}:{}:{}",
                BASE64_STANDARD.encode([1_u8; 16]),
                short_tag_b64,
                ciphertext_b64
            ),
            &key_b64,
        )
        .expect_err("tag length");
        assert!(tag_err.contains("auth tag length"));
    }

    #[test]
    fn sanitize_env_value_strips_ansi_and_control_sequences() {
        let raw = "\u{1b}[?1000l\n  sk-test-key-12345\u{1b}[?2004h\r\n";
        let value = sanitize_env_value(raw);
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn extract_marked_value_ignores_noisy_shell_output() {
        let stdout = concat!(
            "startup banner\n",
            "\u{1b}[31mplugin failed\u{1b}[0m\n",
            "__OPENUSAGECN_ENV_START__\n",
            "  sk-test-key-12345  \n",
            "__OPENUSAGECN_ENV_END__\n",
            "\u{1b}[32muser@host\u{1b}[0m\n"
        );
        let value = extract_marked_value(
            stdout,
            "__OPENUSAGECN_ENV_START__",
            "__OPENUSAGECN_ENV_END__",
        );
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn extract_marked_value_strips_inline_terminal_sequences_from_marked_value() {
        let stdout = concat!(
            "__OPENUSAGECN_ENV_START__\n",
            "\u{1b}[?1000l\n",
            "  sk-test-key-12345\u{1b}[?2004h\r\n",
            "__OPENUSAGECN_ENV_END__\n"
        );
        let value = extract_marked_value(
            stdout,
            "__OPENUSAGECN_ENV_START__",
            "__OPENUSAGECN_ENV_END__",
        );
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn extract_marked_value_returns_none_when_marked_value_is_empty() {
        let stdout = "__OPENUSAGECN_ENV_START__\n  \n__OPENUSAGECN_ENV_END__\n";
        let value = extract_marked_value(
            stdout,
            "__OPENUSAGECN_ENV_START__",
            "__OPENUSAGECN_ENV_END__",
        );
        assert!(value.is_none());
    }

    #[test]
    fn parse_interactive_shell_env_output_does_not_fallback_to_end_marker_for_empty_value() {
        let stdout = "__OPENUSAGECN_ENV_START__\n  \n__OPENUSAGECN_ENV_END__\n";
        let value = parse_interactive_shell_env_output(
            stdout,
            "__OPENUSAGECN_ENV_START__",
            "__OPENUSAGECN_ENV_END__",
        );
        assert!(value.is_none());
    }

    #[test]
    fn parse_interactive_shell_env_output_falls_back_without_markers() {
        let stdout = "\u{1b}[?1000l\n  sk-test-key-12345\u{1b}[?2004h\r\n";
        let value = parse_interactive_shell_env_output(
            stdout,
            "__OPENUSAGECN_ENV_START__",
            "__OPENUSAGECN_ENV_END__",
        );
        assert_eq!(value.as_deref(), Some("sk-test-key-12345"));
    }

    #[test]
    fn http_api_exposes_https_base_url_normalization_to_quickjs() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");

            let normalized: Option<String> = ctx
                .eval(
                    r#"__openusage_ctx.host.http.normalizeHttpsBaseUrl(" https://Gateway.Example:8443/openrouter/v1/ ")"#,
                )
                .expect("normalize valid base URL");
            assert_eq!(
                normalized.as_deref(),
                Some("https://gateway.example:8443/openrouter/v1")
            );

            let rejected_is_null: bool = ctx
                .eval(
                    r#"__openusage_ctx.host.http.normalizeHttpsBaseUrl("https://openrouter.ai@attacker.example/api/v1") === null"#,
                )
                .expect("reject endpoint userinfo");
            assert!(rejected_is_null);
        });
    }

    #[test]
    fn crypto_api_exposes_decrypt() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let crypto: Object = host.get("crypto").expect("crypto");
            let _decrypt: Function = crypto.get("decryptAes256Gcm").expect("decryptAes256Gcm");
            let _encrypt: Function = crypto.get("encryptAes256Gcm").expect("encryptAes256Gcm");
        });
    }

    #[test]
    fn crypto_api_decrypts_node_generated_envelope_from_js() {
        let (key_b64, envelope, expected_plaintext) = node_generated_aes_256_gcm_vector_for_test();
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let js_expr = format!(
                r#"__openusage_ctx.host.crypto.decryptAes256Gcm("{}", "{}")"#,
                envelope, key_b64
            );
            let decrypted: String = ctx.eval(js_expr).expect("js decrypt");
            assert_eq!(decrypted, expected_plaintext);
        });
    }

    #[test]
    fn crypto_api_exposes_sha256_hex() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            // Vector: `printf '%s' 'hello' | shasum -a 256`
            let result: String = ctx
                .eval(r#"__openusage_ctx.host.crypto.sha256Hex("hello")"#)
                .expect("js sha256");
            assert_eq!(
                result,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            );

            let empty: String = ctx
                .eval(r#"__openusage_ctx.host.crypto.sha256Hex("")"#)
                .expect("js sha256 empty");
            assert_eq!(
                empty,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            );
        });
    }

    #[test]
    fn fs_conditional_write_reports_conflicts_without_overwriting() {
        let dir = std::env::temp_dir().join(format!(
            "openusage-host-fs-conditional-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp directory");
        let path = dir.join("auth.json");
        std::fs::write(&path, "original").expect("seed auth file");
        let path_json = serde_json::to_string(&path.to_string_lossy()).expect("encode path");
        let original_digest = crate::safe_file::sha256_hex(b"original");

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            inject_host_api(&ctx, "test", &dir, "0.0.0").expect("inject host api");
            let first: bool = ctx
                .eval(format!(
                    "__openusage_ctx.host.fs.writeTextIfUnchanged({path_json}, 'first', '{original_digest}')"
                ))
                .expect("matching conditional write");
            let stale: bool = ctx
                .eval(format!(
                    "__openusage_ctx.host.fs.writeTextIfUnchanged({path_json}, 'stale', '{original_digest}')"
                ))
                .expect("stale conditional write");

            assert!(first);
            assert!(!stale);
        });

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keychain_api_exposes_write_variants() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let keychain: Object = host.get("keychain").expect("keychain");
            let _read: Function = keychain
                .get("readGenericPassword")
                .expect("readGenericPassword");
            let _read_current_user: Function = keychain
                .get("readGenericPasswordForCurrentUser")
                .expect("readGenericPasswordForCurrentUser");
            let _write: Function = keychain
                .get("writeGenericPassword")
                .expect("writeGenericPassword");
            let _write_current_user: Function = keychain
                .get("writeGenericPasswordForCurrentUser")
                .expect("writeGenericPasswordForCurrentUser");
        });
    }

    #[test]
    fn keychain_read_generic_password_accepts_optional_account_arg_from_js() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");

            let message: String = ctx
                .eval(
                    r#"
                    try {
                        __openusage_ctx.host.keychain.readGenericPassword("__openusage_missing_service__");
                        "ok";
                    } catch (e) {
                        String(e);
                    }
                    "#,
                )
                .expect("js eval");

            assert!(
                !message.contains("2 where expected"),
                "single-arg call should reach the keychain implementation, got: {}",
                message
            );
        });
    }

    #[test]
    fn ls_command_matches_language_server_variants() {
        assert!(ls_command_matches_process(
            "/Applications/Antigravity IDE.app/Contents/Resources/language_server_macos_arm --app_data_dir antigravity-ide",
            "language_server"
        ));
        assert!(ls_command_matches_process(
            "/tmp/language_server --app_data_dir antigravity-ide",
            "language_server"
        ));
    }

    #[test]
    fn ls_command_matches_short_process_names_exactly() {
        assert!(ls_command_matches_process(
            "/opt/homebrew/bin/agy --some-flag",
            "agy"
        ));
        assert!(ls_command_matches_process(
            "/Applications/Antigravity IDE.app/Contents/Resources/agy --some-flag",
            "agy"
        ));
        assert!(ls_command_matches_process(
            "\"/Applications/Antigravity IDE.app/Contents/Resources/agy\" --some-flag",
            "agy"
        ));
        assert!(!ls_command_matches_process(
            "/opt/homebrew/bin/not-agy-helper --some-flag agy",
            "agy"
        ));
    }

    #[test]
    fn ls_marker_rank_prefers_exact_flags_over_path_fallback() {
        let markers = vec!["antigravity".to_string()];

        assert_eq!(
            ls_marker_rank(
                "/tmp/windsurf/language_server --ide_name antigravity",
                &markers
            ),
            Some(0)
        );
        assert_eq!(
            ls_marker_rank("/tmp/antigravity/language_server", &markers),
            Some(1)
        );
        assert_eq!(
            ls_marker_rank(
                "/tmp/antigravity/language_server --ide_name windsurf",
                &markers
            ),
            None
        );
    }

    struct EnvVarGuard {
        name: &'static str,
        old: Option<String>,
    }

    impl EnvVarGuard {
        fn set(name: &'static str, value: &str) -> Self {
            let old = std::env::var(name).ok();
            // SAFETY: tests that mutate env use this guard to restore the previous value on drop.
            unsafe { std::env::set_var(name, value) };
            Self { name, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = self.old.take() {
                // SAFETY: value is restored to the process env at the end of the test.
                unsafe { std::env::set_var(self.name, value) };
            } else {
                // SAFETY: var is removed only when it was absent before the test.
                unsafe { std::env::remove_var(self.name) };
            }
        }
    }

    fn host_env_value_for_plugin(plugin_id: &str, name: &str) -> Option<String> {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, plugin_id, &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let env: Object = host.get("env").expect("env");
            let get: Function = env.get("get").expect("get");
            get.call((name.to_string(),)).expect("get env var")
        })
    }

    #[test]
    #[serial]
    fn env_api_respects_allowlist_in_host_and_js() {
        let claude_env_vars = [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "USER_TYPE",
            "USE_STAGING_OAUTH",
            "USE_LOCAL_OAUTH",
            "CLAUDE_CODE_CUSTOM_OAUTH_URL",
            "CLAUDE_CODE_OAUTH_CLIENT_ID",
            "CLAUDE_LOCAL_OAUTH_API_BASE",
        ];

        for name in claude_env_vars {
            assert!(
                WHITELISTED_ENV_VARS.contains(&name),
                "{name} must be whitelisted for Claude auth compatibility"
            );
        }

        let _claude_config = EnvVarGuard::set("CLAUDE_CONFIG_DIR", "/tmp/openusage-claude");
        let _opencode_cookie = EnvVarGuard::set("OPENCODE_COOKIE", "__Host-auth=scoped-test");

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "claude", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let env: Object = host.get("env").expect("env");
            let get: Function = env.get("get").expect("get");

            for name in claude_env_vars {
                let expected = resolve_env_value(name);
                let value: Option<String> =
                    get.call((name.to_string(),)).expect("get whitelisted var");
                assert_eq!(value, expected, "{name} should match host env resolver");

                let js_expr = format!(r#"__openusage_ctx.host.env.get("{}")"#, name);
                let js_value: Option<String> = ctx.eval(js_expr).expect("js get whitelisted var");
                assert_eq!(
                    js_value, expected,
                    "{name} should match host env resolver from JS"
                );
            }

            let cross_plugin_value: Option<String> = get
                .call(("OPENCODE_COOKIE".to_string(),))
                .expect("get cross-plugin var");
            assert!(
                cross_plugin_value.is_none(),
                "whitelisted vars for other plugins must not be exposed"
            );

            let js_cross_plugin_value: Option<String> = ctx
                .eval(r#"__openusage_ctx.host.env.get("OPENCODE_COOKIE")"#)
                .expect("js get cross-plugin var");
            assert!(
                js_cross_plugin_value.is_none(),
                "whitelisted vars for other plugins must not be exposed from JS"
            );

            let blocked: Option<String> = get
                .call(("__OPENUSAGECN_TEST_NOT_WHITELISTED__".to_string(),))
                .expect("get blocked var");
            assert!(
                blocked.is_none(),
                "non-whitelisted vars must not be exposed"
            );

            let js_blocked: Option<String> = ctx
                .eval(r#"__openusage_ctx.host.env.get("__OPENUSAGECN_TEST_NOT_WHITELISTED__")"#)
                .expect("js get blocked var");
            assert!(
                js_blocked.is_none(),
                "non-whitelisted vars must not be exposed from JS"
            );
        });
    }

    #[test]
    fn env_api_allows_bigmodel_keys_and_blocks_unlisted_keys() {
        for name in ["BIGMODEL_API_KEY", "ZHIPUAI_API_KEY"] {
            assert!(
                WHITELISTED_ENV_VARS.contains(&name),
                "{name} must be whitelisted for BigModel CN plugin auth"
            );
        }

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "bigmodel-cn", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let env: Object = host.get("env").expect("env");
            let get: Function = env.get("get").expect("get");

            for name in ["BIGMODEL_API_KEY", "ZHIPUAI_API_KEY"] {
                let expected = resolve_env_value(name);
                let value: Option<String> =
                    get.call((name.to_string(),)).expect("get BigModel env var");
                assert_eq!(value, expected, "{name} should match host env resolver");
            }

            let blocked: Option<String> = get
                .call(("BIGMODEL_CN_TEST_NOT_ALLOWED".to_string(),))
                .expect("get blocked var");
            assert!(
                blocked.is_none(),
                "non-whitelisted vars must not be exposed"
            );
        });
    }

    #[test]
    #[serial]
    fn env_api_allows_codexbar_gap_provider_vars() {
        for name in [
            "OPENAI_ADMIN_KEY",
            "OPENAI_API_KEY",
            "OPENAI_PROJECT_ID",
            "OPENROUTER_API_KEY",
            "OPENROUTER_API_URL",
            "OPENROUTER_HTTP_REFERER",
            "OPENROUTER_X_TITLE",
            "GEMINI_CONFIG_DIR",
            "ALIBABA_CODING_PLAN_API_KEY",
            "ALIBABA_QWEN_API_KEY",
            "DASHSCOPE_API_KEY",
            "ALIBABA_CODING_PLAN_COOKIE",
            "ALIBABA_TOKEN_PLAN_COOKIE",
            "OPENCODE_COOKIE",
            "OPENCODE_WORKSPACE_ID",
        ] {
            assert!(
                WHITELISTED_ENV_VARS.contains(&name),
                "{name} must be whitelisted for CodexBar gap provider plugins"
            );
        }

        let _opencode_cookie = EnvVarGuard::set("OPENCODE_COOKIE", "__Host-auth=scoped-test");
        let _alibaba_cookie =
            EnvVarGuard::set("ALIBABA_CODING_PLAN_COOKIE", "alibaba-cookie-scoped-test");

        assert_eq!(
            host_env_value_for_plugin("opencode", "OPENCODE_COOKIE").as_deref(),
            Some("__Host-auth=scoped-test")
        );
        assert_eq!(
            host_env_value_for_plugin("alibaba-coding-plan", "ALIBABA_CODING_PLAN_COOKIE")
                .as_deref(),
            Some("alibaba-cookie-scoped-test")
        );
        assert!(
            host_env_value_for_plugin("openrouter", "OPENCODE_COOKIE").is_none(),
            "OpenRouter must not read OpenCode cookie env"
        );
        assert!(
            host_env_value_for_plugin("opencode", "ALIBABA_CODING_PLAN_COOKIE").is_none(),
            "OpenCode must not read Alibaba cookie env"
        );
    }

    #[test]
    #[serial]
    fn env_api_prefers_process_env() {
        let name = "ZAI_API_KEY";
        let _restore = EnvVarGuard::set(name, "zai-process-env-test-value");

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "zai", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let env: Object = host.get("env").expect("env");
            let get: Function = env.get("get").expect("get");

            let value: Option<String> = get.call((name.to_string(),)).expect("get");
            assert_eq!(
                value.as_deref(),
                Some("zai-process-env-test-value"),
                "process env should be preferred over shell lookup"
            );

            let js_value: Option<String> = ctx
                .eval(r#"__openusage_ctx.host.env.get("ZAI_API_KEY")"#)
                .expect("js get");
            assert_eq!(
                js_value.as_deref(),
                Some("zai-process-env-test-value"),
                "process env should be preferred from JS"
            );
        });
    }

    #[test]
    fn current_macos_keychain_account_prefers_explicit_user_value() {
        assert_eq!(
            current_macos_keychain_account_from_user_env(Some("openusagecn-test-user".to_string())),
            "openusagecn-test-user"
        );
    }

    #[test]
    fn expand_path_expands_tilde_prefix() {
        let home = dirs::home_dir().expect("home dir");
        let expected = home.join(".claude-custom").to_string_lossy().to_string();

        assert_eq!(expand_path("~/.claude-custom"), expected);
    }

    #[test]
    fn keychain_find_generic_password_args_include_service_only_lookup() {
        let args = keychain_find_generic_password_args("Claude Code-credentials");
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ]
        );
    }

    #[test]
    fn keychain_find_generic_password_args_for_account_include_account_and_service() {
        let args = keychain_find_generic_password_args_for_account(
            "Claude Code-credentials",
            "openusagecn-test-user",
        );
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "find-generic-password",
                "-a",
                "openusagecn-test-user",
                "-s",
                "Claude Code-credentials",
                "-w",
            ]
        );
    }

    #[test]
    fn keychain_add_generic_password_args_include_service_only_write() {
        let args = keychain_add_generic_password_args("Claude Code-credentials", "secret-value");
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "add-generic-password",
                "-U",
                "-s",
                "Claude Code-credentials",
                "-w",
                "secret-value",
            ]
        );
    }

    #[test]
    fn keychain_add_generic_password_args_for_account_include_update_account_service_and_value() {
        let args = keychain_add_generic_password_args_for_account(
            "Claude Code-credentials",
            "openusagecn-test-user",
            "secret-value",
        );
        let rendered: Vec<String> = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            rendered,
            vec![
                "add-generic-password",
                "-U",
                "-a",
                "openusagecn-test-user",
                "-s",
                "Claude Code-credentials",
                "-w",
                "secret-value",
            ]
        );
    }

    #[test]
    fn redact_value_shows_first_and_last_four() {
        assert_eq!(redact_value("sk-1234567890abcdef"), "sk-1...cdef");
        assert_eq!(redact_value("short"), "[REDACTED]");
    }

    #[test]
    fn redact_url_redacts_api_key_param() {
        let url = "https://api.example.com/v1?api_key=sk-1234567890abcdef&other=value";
        let redacted = redact_url(url);
        assert!(redacted.contains("api_key=sk-1...cdef"));
        assert!(redacted.contains("other=value"));
    }

    #[test]
    fn redact_url_redacts_user_query_param() {
        let url = "https://cursor.com/api/usage?user=user_abcdefghijklmnopqrstuvwxyz&limit=10";
        let redacted = redact_url(url);
        assert!(
            redacted.contains("user=user...wxyz"),
            "user query param should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("limit=10"),
            "non-sensitive params should be preserved, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_url_preserves_non_sensitive_params() {
        let url = "https://api.example.com/v1?limit=10&offset=20";
        assert_eq!(redact_url(url), url);
    }

    #[test]
    fn redact_url_redacts_profile_arn_query_param() {
        let url = "https://q.us-east-1.amazonaws.com/getUsageLimits?profileArn=arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK&origin=AI_EDITOR";
        let redacted = redact_url(url);
        assert!(
            !redacted.contains("699475941385"),
            "profileArn should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("origin=AI_EDITOR"),
            "non-sensitive params should remain visible, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_url_redacts_provider_account_and_browser_session_identifiers() {
        let url = "https://example.com/api?candidateId=candidate-1234567890&sessionRef=session-1234567890&normalizedIdentity=auth0-user-1234567890&profileKey=Profile-Work-1234567890&limit=10";
        let redacted = redact_url(url);

        for sensitive in [
            "candidate-1234567890",
            "session-1234567890",
            "auth0-user-1234567890",
            "Profile-Work-1234567890",
        ] {
            assert!(
                !redacted.contains(sensitive),
                "provider account identifier should be redacted, got: {redacted}"
            );
        }
        assert!(redacted.contains("limit=10"));
    }

    #[test]
    fn redact_body_redacts_jwt() {
        let body = r#"{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}"#;
        let redacted = redact_body(body);
        // JWT gets redacted to first4...last4 format
        assert!(
            !redacted.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "full JWT should be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_api_keys() {
        let body = r#"{"key": "sk-1234567890abcdefghij"}"#;
        let redacted = redact_body(body);
        assert!(redacted.contains("sk-1...ghij"));
    }

    #[test]
    fn redact_body_redacts_devin_session_token() {
        let body = r#"metadata apiKey=devin-session-token$abcdefghijklmnopqrstuvwxyz123456"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("devin-session-token$abcdefghijklmnopqrstuvwxyz123456"),
            "Devin session token should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("devi...3456"),
            "Devin session token should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_json_password_field() {
        let body = r#"{"password": "supersecretpassword123"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("supersecretpassword123"),
            "password should be redacted, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_user_id_and_email() {
        let body = r#"{"user_id": "user-iupzZ7KFykMLrnzpkHSq7wjo", "email": "rob@sunstory.com"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("user-iupzZ7KFykMLrnzpkHSq7wjo"),
            "user_id should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("rob@sunstory.com"),
            "email should be redacted, got: {}",
            redacted
        );
        // Should show first4...last4
        assert!(
            redacted.contains("user...7wjo"),
            "user_id should show first4...last4, got: {}",
            redacted
        );
        assert!(
            redacted.contains("rob@....com"),
            "email should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_camel_case_user_and_account_ids() {
        let body = r#"{"userId": "user_abcdefghijklmnopqrstuvwxyz", "accountId": "acct_1234567890abcdef"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("user_abcdefghijklmnopqrstuvwxyz"),
            "userId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("acct_1234567890abcdef"),
            "accountId should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("user...wxyz"),
            "userId should show first4...last4, got: {}",
            redacted
        );
        assert!(
            redacted.contains("acct...cdef"),
            "accountId should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_provider_account_browser_and_history_fields() {
        let body = r#"{"cookieHeader":"WorkosCursorSessionToken=secret-cookie-value-1234567890","candidateId":"candidate-1234567890","sessionRef":"session-1234567890","storeId":"store-1234567890","subject":"auth0-user-1234567890","normalizedIdentity":"auth0-user-1234567890","profileKey":"Profile-Work-1234567890","organizationUuid":"org-1234567890","emailAddress":"member-private@example.com","owningUser":"owner-1234567890","owningTeam":"team-1234567890","credentialGeneration":"generation-1234567890"}"#;
        let redacted = redact_body(body);

        for sensitive in [
            "secret-cookie-value-1234567890",
            "candidate-1234567890",
            "session-1234567890",
            "store-1234567890",
            "auth0-user-1234567890",
            "Profile-Work-1234567890",
            "org-1234567890",
            "member-private@example.com",
            "owner-1234567890",
            "team-1234567890",
            "generation-1234567890",
        ] {
            assert!(
                !redacted.contains(sensitive),
                "provider account field should be redacted, got: {redacted}"
            );
        }
    }

    #[test]
    fn redact_body_redacts_devin_org_and_account_display_name() {
        let body = r#"{"orgId":"org-6b6e9de248db472bb25b296599ea3dc0","accountDisplayName":"rob@sunstory.com","devinInfo":{"org_id":"org-abcdef1234567890","account_display_name":"team@example.com"}}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("org-6b6e9de248db472bb25b296599ea3dc0"),
            "orgId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("rob@sunstory.com"),
            "accountDisplayName should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("org-abcdef1234567890"),
            "org_id should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("team@example.com"),
            "account_display_name should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("org-...3dc0"),
            "orgId should show first4...last4, got: {}",
            redacted
        );
        assert!(
            redacted.contains("rob@....com"),
            "accountDisplayName should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_team_id_payment_id_and_paths() {
        let body = r#"{"teamId":"cc1ac023-9ff5-4c1f-a5a4-ae2a82df4243","paymentId":"cus_S5m1PGxjLWoc1c","binaryPath":"/opt/homebrew/bin/bunx","homePath":"/Users/rebers/.claude"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("cc1ac023-9ff5-4c1f-a5a4-ae2a82df4243"),
            "teamId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("cus_S5m1PGxjLWoc1c"),
            "paymentId should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/opt/homebrew/bin/bunx"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/Users/rebers/.claude"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("[PATH]"),
            "expected path marker, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_profile_arn_fields() {
        let body = r#"{"profileArn":"arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK","profile_arn":"arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("699475941385"),
            "profile arn should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("arn:...QMUK"),
            "profile arn should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_http_response_body_redacts_codex_reset_credit_sensitive_fields() {
        let body = r#"{"credits":[{"id":"reset-credit-1234567890abcdef","title":"Manual reset","description":"Use when needed","profile_user_id":"profile-user-1234567890abcdef","profile_image_url":"https://images.example.com/private/avatar-1234567890abcdef.png"}]}"#;
        let redacted = redact_http_response_body(
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
            body,
        );

        for sensitive in [
            "reset-credit-1234567890abcdef",
            "profile-user-1234567890abcdef",
            "https://images.example.com/private/avatar-1234567890abcdef.png",
        ] {
            assert!(
                !redacted.contains(sensitive),
                "reset credit identifier should be redacted, got: {}",
                redacted
            );
        }
        assert!(
            redacted.contains("rese...cdef"),
            "reset credit id should use first4...last4 redaction, got: {}",
            redacted
        );
        assert!(
            redacted.contains("prof...cdef"),
            "profile user id should use first4...last4 redaction, got: {}",
            redacted
        );
        assert!(
            redacted.contains("http....png"),
            "profile image URL should use first4...last4 redaction, got: {}",
            redacted
        );
        for visible in [
            r#""title":"Manual reset""#,
            r#""description":"Use when needed""#,
        ] {
            assert!(
                redacted.contains(visible),
                "non-sensitive reset inventory field should remain visible, got: {}",
                redacted
            );
        }
    }

    #[test]
    fn redact_body_preserves_unrelated_generic_id() {
        let body = r#"{"id":"diagnostic-object-1234567890","status":"active"}"#;

        assert_eq!(redact_body(body), body);
    }

    #[test]
    fn redact_http_response_body_scopes_codex_inventory_rules_to_its_endpoint() {
        let body = r#"{"credits":[{"id":"diagnostic-object-1234567890","profile_user_id":"profile-user-1234567890"}]}"#;

        assert_eq!(
            redact_http_response_body("https://example.com/usage", body),
            body
        );
    }

    #[test]
    fn redact_log_message_redacts_jwt_and_api_key() {
        let msg = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U key=sk-1234567890abcdef";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "JWT should be redacted"
        );
        assert!(
            !redacted.contains("sk-1234567890abcdef"),
            "API key should be redacted"
        );
    }

    #[test]
    fn redact_log_message_redacts_dynamic_secret_as_literal_text() {
        let secret = "id.part+token/secret=20260615";
        register_secret_for_redaction(secret);
        let redacted = redact_log_message(&format!("configured api key: {secret}"));

        assert!(
            !redacted.contains(secret),
            "dynamic secret should be redacted literally, got: {}",
            redacted
        );
        assert!(redacted.contains("id.p...0615"));
    }

    #[test]
    fn redact_log_message_ignores_short_dynamic_secrets() {
        let secret = "a.b+c";
        register_secret_for_redaction(secret);
        let msg = format!("short token remains visible for diagnostics: {secret}");

        assert_eq!(redact_log_message(&msg), msg);
    }

    #[test]
    fn redact_log_message_redacts_devin_session_token() {
        let msg = "auth=devin-session-token$abcdefghijklmnopqrstuvwxyz123456";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("devin-session-token$abcdefghijklmnopqrstuvwxyz123456"),
            "Devin session token should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("devi...3456"),
            "Devin session token should use first4...last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_log_message_redacts_account_and_paths() {
        let msg = "keychain read: service=Claude Code-credentials, account=rebers path=/opt/homebrew/bin/bunx home=/Users/rebers/.claude";
        let redacted = redact_log_message(msg);
        assert!(
            !redacted.contains("account=rebers"),
            "account should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/opt/homebrew/bin/bunx"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("/Users/rebers/.claude"),
            "path should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("account=[REDACTED]"),
            "expected redacted account, got: {}",
            redacted
        );
        assert!(
            redacted.contains("[PATH]"),
            "expected redacted path, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_log_message_redacts_windows_drive_and_unc_paths() {
        let msg = r#"auth path=C:\Users\张 三\.codex\auth.json, backup=\\server\AI Team\auth.json, extended=\\?\C:\Users\Name\auth.json"#;
        let redacted = redact_log_message(msg);

        assert!(
            !redacted.contains(r#"C:\Users\张 三"#),
            "drive path leaked: {redacted}"
        );
        assert!(
            !redacted.contains(r#"\\server\AI Team"#),
            "UNC path leaked: {redacted}"
        );
        assert!(
            !redacted.contains(r#"\\?\C:\Users\Name"#),
            "extended path leaked: {redacted}"
        );
        assert_eq!(
            redacted.matches("[PATH]").count(),
            3,
            "unexpected redaction: {redacted}"
        );
    }

    #[test]
    fn redact_log_message_redacts_forward_slash_windows_path_without_hiding_url() {
        let msg = "url=https://chatgpt.com/usage path=D:/Codex Data/auth.json";
        let redacted = redact_log_message(msg);

        assert!(redacted.contains("https://chatgpt.com/usage"));
        assert!(!redacted.contains("D:/Codex Data/auth.json"));
        assert!(redacted.contains("path=[PATH]"));
    }

    #[test]
    fn redact_body_redacts_login_and_analytics_tracking_id() {
        let body =
            r#"{"login":"robinebers","analytics_tracking_id":"c9df3f012bb8c2eb7aae6868ee8da6cf"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("robinebers"),
            "login should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("c9df3f012bb8c2eb7aae6868ee8da6cf"),
            "analytics_tracking_id should be redacted, got: {}",
            redacted
        );
        // login is short (<=12 chars) so becomes [REDACTED]; analytics_tracking_id is long so first4...last4
        assert!(
            redacted.contains("[REDACTED]"),
            "login should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("c9df...a6cf"),
            "analytics_tracking_id should show first4...last4, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_form_encoded_tokens_and_csrf() {
        let body =
            "params=%7B%7D&sec_token=abcdefghijklmnopqrstuvwxyz123456&csrf=csrf-public-value-12345";
        let redacted = redact_body(body);

        assert!(
            !redacted.contains("abcdefghijklmnopqrstuvwxyz123456"),
            "sec_token should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("csrf-public-value-12345"),
            "csrf should be redacted, got: {}",
            redacted
        );
        assert!(
            redacted.contains("sec_token=abcd...3456"),
            "expected sec_token first4/last4 redaction, got: {}",
            redacted
        );
        assert!(
            redacted.contains("csrf=csrf...2345"),
            "expected csrf first4/last4 redaction, got: {}",
            redacted
        );
    }

    #[test]
    fn redact_body_redacts_name_field() {
        let body =
            r#"{"userStatus":{"name":"Robin Ebers","email":"rob@sunstory.com","planStatus":{}}}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("Robin Ebers"),
            "name should be redacted, got: {}",
            redacted
        );
        assert!(
            !redacted.contains("rob@sunstory.com"),
            "email should be redacted, got: {}",
            redacted
        );
        // "Robin Ebers" is 11 chars (<=12) so becomes [REDACTED]
        assert!(
            redacted.contains("\"name\": \"[REDACTED]\""),
            "name should show [REDACTED], got: {}",
            redacted
        );
    }

    #[test]
    fn ccusage_runner_order_matches_expected_priority() {
        assert_eq!(
            ccusage_runner_order(),
            [
                CcusageRunnerKind::Bunx,
                CcusageRunnerKind::PnpmDlx,
                CcusageRunnerKind::YarnDlx,
                CcusageRunnerKind::NpmExec,
                CcusageRunnerKind::Npx
            ]
        );
    }

    #[test]
    fn ccusage_runner_args_include_expected_non_interactive_flags() {
        let opts = CcusageQueryOpts {
            provider: None,
            since: Some("20260101".to_string()),
            until: Some("20260131".to_string()),
            home_path: None,
            claude_path: None,
        };
        let expected_ccusage_package = ccusage_package_spec();
        assert_eq!(expected_ccusage_package, "ccusage@20.0.20");
        let expected_npm_exec_package = format!("--package={expected_ccusage_package}");

        let bunx = ccusage_runner_args(
            CcusageRunnerKind::Bunx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            bunx,
            vec![
                "--silent",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let pnpm = ccusage_runner_args(
            CcusageRunnerKind::PnpmDlx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            pnpm,
            vec![
                "-s",
                "dlx",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let yarn = ccusage_runner_args(
            CcusageRunnerKind::YarnDlx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            yarn,
            vec![
                "dlx",
                "-q",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npm_exec = ccusage_runner_args(
            CcusageRunnerKind::NpmExec,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npm_exec,
            vec![
                "exec",
                "--yes",
                expected_npm_exec_package.as_str(),
                "--",
                "ccusage",
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npx = ccusage_runner_args(
            CcusageRunnerKind::Npx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npx,
            vec![
                "--yes",
                expected_ccusage_package.as_str(),
                "claude",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );
    }

    #[test]
    fn ccusage_runner_args_codex_use_unified_package_and_bin() {
        let opts = CcusageQueryOpts {
            provider: Some("codex".to_string()),
            since: Some("20260101".to_string()),
            until: Some("20260131".to_string()),
            home_path: None,
            claude_path: None,
        };
        let expected_ccusage_package = ccusage_package_spec();
        let expected_npm_exec_package = format!("--package={expected_ccusage_package}");

        let bunx = ccusage_runner_args(
            CcusageRunnerKind::Bunx,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            bunx,
            vec![
                "--silent",
                expected_ccusage_package.as_str(),
                "codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npm_exec = ccusage_runner_args(
            CcusageRunnerKind::NpmExec,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npm_exec,
            vec![
                "exec",
                "--yes",
                expected_npm_exec_package.as_str(),
                "--",
                "ccusage",
                "codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let npx = ccusage_runner_args(
            CcusageRunnerKind::Npx,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Current,
        );
        assert_eq!(
            npx,
            vec![
                "--yes",
                expected_ccusage_package.as_str(),
                "codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );
    }

    #[test]
    fn ccusage_runner_args_legacy_fallback_uses_release_age_safe_packages() {
        let opts = CcusageQueryOpts {
            provider: None,
            since: Some("20260101".to_string()),
            until: Some("20260131".to_string()),
            home_path: None,
            claude_path: None,
        };

        let claude = ccusage_runner_args(
            CcusageRunnerKind::Bunx,
            &opts,
            CcusageProvider::Claude,
            CcusageCommandFlavor::Legacy,
        );
        assert_eq!(
            claude,
            vec![
                "--silent",
                "ccusage@18.0.11",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );

        let codex_npm = ccusage_runner_args(
            CcusageRunnerKind::NpmExec,
            &opts,
            CcusageProvider::Codex,
            CcusageCommandFlavor::Legacy,
        );
        assert_eq!(
            codex_npm,
            vec![
                "exec",
                "--yes",
                "--package=@ccusage/codex@18.0.11",
                "--",
                "ccusage-codex",
                "daily",
                "--json",
                "--order",
                "desc",
                "--since",
                "20260101",
                "--until",
                "20260131"
            ]
        );
    }

    #[test]
    fn ccusage_path_entries_with_home_and_existing_path_preserves_order() {
        let home = std::path::PathBuf::from("/tmp/openusagecn-home");
        let existing = std::env::join_paths([
            std::path::PathBuf::from("/usr/bin"),
            std::path::PathBuf::from("/bin"),
        ])
        .expect("join existing path");

        let entries = ccusage_path_entries_with(Some(home.as_path()), Some(existing.as_os_str()));
        assert_eq!(
            entries,
            vec![
                home.join(".bun/bin"),
                home.join(".nvm/current/bin"),
                home.join(".local/bin"),
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
                std::path::PathBuf::from("/usr/bin"),
                std::path::PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    fn ccusage_path_entries_with_deduplicates_prefix_and_existing_entries() {
        let existing = std::env::join_paths([
            std::path::PathBuf::from("/usr/local/bin"),
            std::path::PathBuf::from("/custom/bin"),
            std::path::PathBuf::from("/custom/bin"),
            std::path::PathBuf::from("/opt/homebrew/bin"),
        ])
        .expect("join existing path");

        let entries = ccusage_path_entries_with(None, Some(existing.as_os_str()));
        assert_eq!(
            entries,
            vec![
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
                std::path::PathBuf::from("/custom/bin"),
            ]
        );
    }

    #[test]
    fn ccusage_enriched_path_with_uses_defaults_without_home_or_existing_path() {
        let enriched = ccusage_enriched_path_with(None, None).expect("enriched path");
        let entries: Vec<std::path::PathBuf> =
            std::env::split_paths(enriched.as_os_str()).collect();
        assert_eq!(
            entries,
            vec![
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn ccusage_enriched_path_with_preserves_entries_after_join_and_split() {
        let home = std::path::PathBuf::from("/tmp/openusagecn-home");
        let existing = std::env::join_paths([
            std::path::PathBuf::from("/usr/bin"),
            std::path::PathBuf::from("/bin"),
        ])
        .expect("join existing path");

        let enriched = ccusage_enriched_path_with(Some(home.as_path()), Some(existing.as_os_str()))
            .expect("path");
        let entries: Vec<std::path::PathBuf> =
            std::env::split_paths(enriched.as_os_str()).collect();

        assert_eq!(
            entries,
            vec![
                home.join(".bun/bin"),
                home.join(".nvm/current/bin"),
                home.join(".local/bin"),
                std::path::PathBuf::from("/opt/homebrew/bin"),
                std::path::PathBuf::from("/usr/local/bin"),
                std::path::PathBuf::from("/usr/bin"),
                std::path::PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    fn nvm_default_bin_path_resolves_version_with_v_prefix() {
        let home = std::env::temp_dir().join("openusagecn-test-nvm-v-prefix");
        let alias_dir = home.join(".nvm/alias");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        std::fs::write(alias_dir.join("default"), "v22.16.0").expect("write alias");
        let result = nvm_default_bin_path(&home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(result, Some(home.join(".nvm/versions/node/v22.16.0/bin")));
    }

    #[test]
    fn nvm_default_bin_path_resolves_version_without_v_prefix() {
        let home = std::env::temp_dir().join("openusagecn-test-nvm-no-v-prefix");
        let alias_dir = home.join(".nvm/alias");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        std::fs::write(alias_dir.join("default"), "22.16.0").expect("write alias");
        let result = nvm_default_bin_path(&home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(result, Some(home.join(".nvm/versions/node/v22.16.0/bin")));
    }

    #[test]
    fn nvm_default_bin_path_returns_none_when_alias_missing() {
        let home = std::env::temp_dir().join("openusagecn-test-nvm-no-alias");
        let _ = std::fs::remove_dir_all(&home);
        let result = nvm_default_bin_path(&home);
        assert_eq!(result, None);
    }

    #[test]
    fn ccusage_path_entries_with_includes_nvm_default_version() {
        let home = std::env::temp_dir().join("openusagecn-test-nvm-entries");
        let alias_dir = home.join(".nvm/alias");
        std::fs::create_dir_all(&alias_dir).expect("create alias dir");
        std::fs::write(alias_dir.join("default"), "22.16.0").expect("write alias");
        let entries = ccusage_path_entries_with(Some(&home), None);
        let _ = std::fs::remove_dir_all(&home);
        assert!(
            entries.contains(&home.join(".nvm/versions/node/v22.16.0/bin")),
            "expected nvm default version bin in entries"
        );
    }

    #[test]
    fn configure_ccusage_command_sets_path_override() {
        let mut command = std::process::Command::new("echo");
        let args = vec!["daily".to_string(), "--json".to_string()];
        let path = std::env::join_paths([
            std::path::PathBuf::from("/tmp/bin"),
            std::path::PathBuf::from("/usr/bin"),
        ])
        .expect("join path override");

        configure_ccusage_command(&mut command, &args, Some(path.as_os_str()));

        let configured_args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(configured_args, args);

        let configured_path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value.map(std::borrow::ToOwned::to_owned));
        assert_eq!(configured_path.as_deref(), Some(path.as_os_str()));
    }

    #[test]
    fn configure_ccusage_command_skips_path_override_when_absent() {
        let mut command = std::process::Command::new("echo");
        let args = vec!["daily".to_string()];

        configure_ccusage_command(&mut command, &args, None);

        let has_path_override = command
            .get_envs()
            .any(|(key, _)| key == std::ffi::OsStr::new("PATH"));
        assert!(
            !has_path_override,
            "PATH should only be set when an override exists"
        );
    }

    #[test]
    fn resolve_ccusage_provider_prefers_explicit_opt_then_plugin_id() {
        let opts_explicit = CcusageQueryOpts {
            provider: Some("codex".to_string()),
            since: None,
            until: None,
            home_path: None,
            claude_path: None,
        };
        assert_eq!(
            resolve_ccusage_provider(&opts_explicit, "claude"),
            CcusageProvider::Codex
        );

        let opts_empty = CcusageQueryOpts::default();
        assert_eq!(
            resolve_ccusage_provider(&opts_empty, "codex"),
            CcusageProvider::Codex
        );
        assert_eq!(
            resolve_ccusage_provider(&opts_empty, "claude"),
            CcusageProvider::Claude
        );
        assert_eq!(
            resolve_ccusage_provider(&opts_empty, "unknown-provider"),
            CcusageProvider::Claude
        );
    }

    #[test]
    fn ccusage_home_override_supports_home_path_and_claude_compat() {
        let with_home = CcusageQueryOpts {
            provider: None,
            since: None,
            until: None,
            home_path: Some("/tmp/shared-home".to_string()),
            claude_path: Some("/tmp/claude-home".to_string()),
        };
        assert_eq!(
            ccusage_home_override(&with_home, CcusageProvider::Claude),
            Some("/tmp/shared-home")
        );
        assert_eq!(
            ccusage_home_override(&with_home, CcusageProvider::Codex),
            Some("/tmp/shared-home")
        );

        let claude_compat = CcusageQueryOpts {
            provider: None,
            since: None,
            until: None,
            home_path: None,
            claude_path: Some("/tmp/legacy-claude-path".to_string()),
        };
        assert_eq!(
            ccusage_home_override(&claude_compat, CcusageProvider::Claude),
            Some("/tmp/legacy-claude-path")
        );
        assert_eq!(
            ccusage_home_override(&claude_compat, CcusageProvider::Codex),
            None
        );
    }

    #[test]
    fn normalize_ccusage_output_converts_empty_array_to_daily_object() {
        let normalized = normalize_ccusage_output("noise\n[]\n").expect("normalized output");
        let value: serde_json::Value = serde_json::from_str(&normalized).expect("valid json");
        assert_eq!(value, serde_json::json!({ "daily": [] }));
    }

    #[test]
    fn normalize_ccusage_output_keeps_daily_object_shape() {
        let output = r#"
Saved lockfile
{
  "daily": [
    { "date": "2026-02-21", "totalTokens": 123, "totalCost": 0.5 }
  ],
  "totals": { "totalTokens": 123 }
}
"#;
        let normalized = normalize_ccusage_output(output).expect("normalized output");
        let value: serde_json::Value = serde_json::from_str(&normalized).expect("valid json");
        assert!(value.get("daily").and_then(|v| v.as_array()).is_some());
        assert!(value.get("totals").is_some());
    }

    #[test]
    fn normalize_ccusage_output_rejects_invalid_payloads() {
        assert!(normalize_ccusage_output("not-json").is_none());
        assert!(normalize_ccusage_output(r#"{"totals":{"totalTokens":1}}"#).is_none());
    }

    #[test]
    fn collect_ccusage_runners_uses_fallback_order() {
        let runners = collect_ccusage_runners_with(|kind| match kind {
            CcusageRunnerKind::Bunx => None,
            CcusageRunnerKind::PnpmDlx => Some("pnpm".to_string()),
            CcusageRunnerKind::YarnDlx => Some("yarn".to_string()),
            CcusageRunnerKind::NpmExec => Some("npm".to_string()),
            CcusageRunnerKind::Npx => Some("npx".to_string()),
        });
        assert_eq!(
            runners,
            vec![
                (CcusageRunnerKind::PnpmDlx, "pnpm".to_string()),
                (CcusageRunnerKind::YarnDlx, "yarn".to_string()),
                (CcusageRunnerKind::NpmExec, "npm".to_string()),
                (CcusageRunnerKind::Npx, "npx".to_string()),
            ]
        );
    }

    #[test]
    fn collect_ccusage_runners_returns_empty_when_none_available() {
        let runners = collect_ccusage_runners_with(|_| None);
        assert!(runners.is_empty());
    }

    #[test]
    fn ccusage_query_guard_blocks_overlapping_provider_query() {
        let first = CcusageQueryGuard::acquire(CcusageProvider::Codex)
            .expect("first query should acquire guard");
        assert!(
            CcusageQueryGuard::acquire(CcusageProvider::Codex).is_none(),
            "second query for same provider should be blocked"
        );
        assert!(
            CcusageQueryGuard::acquire(CcusageProvider::Claude).is_some(),
            "different provider should have its own guard"
        );
        drop(first);
        assert!(
            CcusageQueryGuard::acquire(CcusageProvider::Codex).is_some(),
            "guard should release on drop"
        );
    }

    #[test]
    fn ccusage_timeout_stops_runner_fallback() {
        let opts = CcusageQueryOpts::default();
        let runners = vec![
            (CcusageRunnerKind::Bunx, "bunx".to_string()),
            (CcusageRunnerKind::Npx, "npx".to_string()),
        ];
        let mut calls = Vec::new();

        let result = run_ccusage_query_with_runners(
            runners,
            &opts,
            CcusageProvider::Codex,
            "codex",
            |kind, _, _, _, _| {
                calls.push(kind);
                CcusageRunnerResult::TimedOut
            },
        );

        let value: serde_json::Value = serde_json::from_str(&result).expect("valid status json");
        assert_eq!(value["status"], "runner_failed");
        assert_eq!(calls, vec![CcusageRunnerKind::Bunx]);
    }

    #[cfg(unix)]
    #[test]
    fn ccusage_runner_retries_legacy_package_when_current_package_fails() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let test_id = format!(
            "openusagecn-ccusage-legacy-fallback-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(test_id);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script_path = dir.join("fake-bunx.sh");
        let args_path = dir.join("args.log");

        let mut script = std::fs::File::create(&script_path).expect("create script");
        let script_body = format!(
            r#"#!/bin/sh
echo "$*" >> "{}"
case "$*" in
  *"@ccusage/codex@18.0.11"*)
    printf '{{"daily":[]}}\n'
    exit 0
    ;;
  *)
    echo "blocked current package" >&2
    exit 1
    ;;
esac
"#,
            args_path.display()
        );
        script
            .write_all(script_body.as_bytes())
            .expect("write script");
        let mut permissions = script.metadata().expect("script metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).expect("make script executable");

        let opts = CcusageQueryOpts {
            provider: Some("codex".to_string()),
            since: Some("20260101".to_string()),
            until: None,
            home_path: None,
            claude_path: None,
        };
        let result = run_ccusage_with_runner(
            CcusageRunnerKind::Bunx,
            script_path.to_string_lossy().as_ref(),
            &opts,
            CcusageProvider::Codex,
            "codex",
        );
        assert_eq!(
            result,
            CcusageRunnerResult::Success(r#"{"daily":[]}"#.to_string())
        );

        let calls = std::fs::read_to_string(&args_path).expect("read args log");
        assert!(calls.contains("ccusage@20.0.20 codex daily"));
        assert!(calls.contains("@ccusage/codex@18.0.11 daily"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ccusage_timeout_log_uses_actual_timeout() {
        assert_eq!(
            format_ccusage_timeout(std::time::Duration::from_millis(100)),
            "100ms"
        );
        assert_eq!(
            format_ccusage_timeout(std::time::Duration::from_secs(CCUSAGE_TIMEOUT_SECS)),
            "15s"
        );
    }

    #[test]
    fn probe_deadline_clamps_host_timeout_to_remaining_budget() {
        let deadline = ProbeDeadline::at(Instant::now() + Duration::from_millis(25));
        let clamped = deadline
            .clamp_duration(Duration::from_secs(10))
            .expect("remaining budget should produce a host timeout");

        assert!(
            clamped <= Duration::from_millis(25),
            "host timeout should not exceed remaining probe budget"
        );
        assert!(
            clamped >= Duration::from_millis(1),
            "host timeout should stay non-zero for blocking clients"
        );
    }

    #[test]
    fn probe_deadline_does_not_extend_elapsed_budget() {
        let deadline = ProbeDeadline::at(Instant::now());

        assert_eq!(deadline.clamp_duration(Duration::from_secs(10)), None);
    }

    #[cfg(unix)]
    #[test]
    fn ccusage_timeout_kills_descendant_and_closes_pipes() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        use std::time::{Duration, Instant};

        fn pid_exists(pid: i32) -> bool {
            unsafe { libc::kill(pid, 0) == 0 }
        }

        fn read_pid_file(path: &Path, deadline: Instant) -> i32 {
            loop {
                if let Ok(pid_text) = std::fs::read_to_string(path) {
                    let pid_text = pid_text.trim();
                    if !pid_text.is_empty() {
                        return pid_text.parse().expect("parse descendant pid");
                    }
                }
                if Instant::now() >= deadline {
                    panic!("descendant pid file was not created at {}", path.display());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        let test_id = format!(
            "openusagecn-ccusage-timeout-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(test_id);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script_path = dir.join("fake-ccusage-runner.sh");
        let pid_path = dir.join("descendant.pid");

        let mut script = std::fs::File::create(&script_path).expect("create script");
        let script_body = format!(
            r#"#!/bin/sh
sh -c 'sleep 30' &
echo $! > "{}"
echo "started"
wait
"#,
            pid_path.display()
        );
        script
            .write_all(script_body.as_bytes())
            .expect("write script");
        let mut permissions = script.metadata().expect("script metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).expect("make script executable");

        let opts = CcusageQueryOpts::default();
        let timeout = Duration::from_secs(5);
        let start = Instant::now();
        let result = run_ccusage_with_runner_timeout(
            CcusageRunnerKind::Bunx,
            script_path.to_string_lossy().as_ref(),
            &opts,
            CcusageProvider::Codex,
            "codex",
            CcusageCommandFlavor::Current,
            timeout,
        );

        assert_eq!(result, CcusageRunnerResult::TimedOut);
        assert!(
            start.elapsed() < timeout + Duration::from_secs(2),
            "timeout cleanup should not hang on inherited stdout/stderr pipes"
        );

        let descendant_pid = read_pid_file(&pid_path, Instant::now() + Duration::from_secs(1));

        let deadline = Instant::now() + Duration::from_secs(2);
        while pid_exists(descendant_pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !pid_exists(descendant_pid),
            "descendant process should be killed with ccusage process group"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
