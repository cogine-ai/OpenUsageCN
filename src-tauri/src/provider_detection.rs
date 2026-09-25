//! One-time, local credential checks for newly seen providers.
//! Presence is only a startup hint; the regular probe verifies account access.

use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::LoadedPlugin;
use crate::provider_config;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub fn detect(plugins: &[LoadedPlugin], candidate_ids: &[String]) -> Vec<String> {
    let candidates: HashSet<&str> = candidate_ids.iter().map(String::as_str).collect();
    let env_names: Vec<&str> = [
        ("deepseek", &["DEEPSEEK_API_KEY"][..]),
        ("moonshot", &["MOONSHOT_API_KEY", "MOONSHOT_REGION"][..]),
        ("ollama", &["OLLAMA_CLOUD_COOKIE"][..]),
        (
            "doubao",
            &[
                "VOLCENGINE_ACCESS_KEY_ID",
                "VOLCENGINE_SECRET_ACCESS_KEY",
                "VOLCENGINE_REGION",
            ][..],
        ),
        ("xai", &["XAI_MANAGEMENT_API_KEY", "XAI_TEAM_ID"][..]),
    ]
    .into_iter()
    .filter(|(id, _)| candidates.contains(id))
    .flat_map(|(_, names)| names.iter().copied())
    .collect();
    let env_values = host_api::resolve_env_values(&env_names);
    plugins
        .iter()
        .filter(|plugin| candidates.contains(plugin.manifest.id.as_str()))
        .filter_map(|plugin| {
            let id = plugin.manifest.id.as_str();
            if !matches!(id, "deepseek" | "moonshot" | "ollama" | "doubao" | "xai") {
                return None;
            }
            let fields = &plugin.manifest.config.as_ref()?.fields;
            let values = provider_config::resolved_values(id, fields);
            has_credentials(id, &values, &|name| env_values.get(name).cloned().flatten())
                .then(|| plugin.manifest.id.clone())
        })
        .collect()
}

fn configured(values: &HashMap<String, Value>, field: &str) -> Option<String> {
    values
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn setting<F>(
    values: &HashMap<String, Value>,
    field: &str,
    env: &str,
    read_env: &F,
) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    configured(values, field).or_else(|| read_env(env).filter(|value| !value.trim().is_empty()))
}

fn has_credentials<F>(id: &str, values: &HashMap<String, Value>, read_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    match id {
        "deepseek" => setting(values, "apiKey", "DEEPSEEK_API_KEY", read_env).is_some(),
        "moonshot" => {
            let configured_region = configured(values, "region");
            let env_region = read_env("MOONSHOT_REGION");
            let region = match configured_region.as_deref() {
                None | Some("auto") => env_region.as_deref().unwrap_or("international"),
                Some(value) => value,
            };
            let key_field = match region {
                "china" => "apiKeyCn",
                "international" => "apiKeyIntl",
                _ => return false,
            };
            configured(values, key_field).is_some()
                || (read_env("MOONSHOT_API_KEY").is_some()
                    && env_region.as_deref().unwrap_or("international") == region)
        }
        "ollama" => setting(values, "cookieHeader", "OLLAMA_CLOUD_COOKIE", read_env)
            .is_some_and(|cookie| has_ollama_session_cookie(&cookie)),
        "doubao" => {
            let region = setting(values, "region", "VOLCENGINE_REGION", read_env)
                .unwrap_or_else(|| "cn-beijing".to_string());
            !region.is_empty()
                && region
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
                && setting(values, "accessKeyId", "VOLCENGINE_ACCESS_KEY_ID", read_env).is_some()
                && setting(
                    values,
                    "secretAccessKey",
                    "VOLCENGINE_SECRET_ACCESS_KEY",
                    read_env,
                )
                .is_some()
        }
        "xai" => {
            let team = setting(values, "teamId", "XAI_TEAM_ID", read_env);
            setting(values, "managementKey", "XAI_MANAGEMENT_API_KEY", read_env).is_some()
                && team.is_some_and(|value| {
                    !value.is_empty()
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
        }
        _ => false,
    }
}

fn has_ollama_session_cookie(raw: &str) -> bool {
    let trimmed = raw.trim();
    let cookie = if trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cookie:"))
    {
        trimmed[7..].trim()
    } else {
        trimmed
    };
    if cookie.is_empty() || cookie.chars().any(char::is_control) {
        return false;
    }
    let mut has_session = false;
    for part in cookie.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((name, value)) = part.split_once('=') else {
            return false;
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
        {
            return false;
        }
        has_session |= !value.trim().is_empty()
            && (matches!(
                name,
                "session"
                    | "__Secure-session"
                    | "ollama_session"
                    | "__Host-ollama_session"
                    | "wos-session"
                    | "__Secure-next-auth.session-token"
                    | "next-auth.session-token"
            ) || name.starts_with("__Secure-next-auth.session-token.")
                || name.starts_with("next-auth.session-token."));
    }
    has_session
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(entries: &[(&str, &str)]) -> HashMap<String, Value> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
            .collect()
    }

    #[test]
    fn detects_only_usable_credentials_for_the_five_providers() {
        let env = |name: &str| match name {
            "DEEPSEEK_API_KEY" => Some("deepseek-key".to_string()),
            "MOONSHOT_API_KEY" => Some("china-key".to_string()),
            "MOONSHOT_REGION" => Some("china".to_string()),
            "VOLCENGINE_SECRET_ACCESS_KEY" => Some("secret".to_string()),
            "XAI_TEAM_ID" => Some("team_123".to_string()),
            _ => None,
        };

        assert!(has_credentials("deepseek", &values(&[]), &env));
        assert!(has_credentials("moonshot", &values(&[]), &env));
        assert!(!has_credentials(
            "moonshot",
            &values(&[("region", "international")]),
            &env
        ));
        assert!(has_credentials(
            "ollama",
            &values(&[("cookieHeader", "Cookie: __Secure-session=abc; theme=dark")]),
            &env
        ));
        assert!(!has_credentials(
            "ollama",
            &values(&[("cookieHeader", "theme=dark")]),
            &env
        ));
        assert!(!has_credentials(
            "ollama",
            &values(&[("cookieHeader", "__Secure-session=; theme=dark")]),
            &env
        ));
        assert!(has_credentials(
            "doubao",
            &values(&[("accessKeyId", "access")]),
            &env
        ));
        assert!(!has_credentials("doubao", &values(&[]), &env));
        assert!(has_credentials(
            "xai",
            &values(&[("managementKey", "management")]),
            &env
        ));
        assert!(!has_credentials(
            "xai",
            &values(&[("managementKey", "management"), ("teamId", "bad/team")]),
            &env
        ));
    }
}
