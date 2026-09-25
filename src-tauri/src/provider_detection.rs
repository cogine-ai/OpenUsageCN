//! One-time, local credential checks for newly seen providers.
//! Presence is only a startup hint; the regular probe verifies account access.

use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::LoadedPlugin;
use crate::provider_config;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub detected_ids: Vec<String>,
    pub retry_ids: Vec<String>,
}

pub fn detect(plugins: &[LoadedPlugin], candidate_ids: &[String]) -> DetectionResult {
    let candidates: HashSet<&str> = candidate_ids.iter().map(String::as_str).collect();
    let candidate_values: Vec<(String, HashMap<String, Value>)> = plugins
        .iter()
        .filter(|plugin| candidates.contains(plugin.manifest.id.as_str()))
        .filter_map(|plugin| {
            let id = plugin.manifest.id.as_str();
            if !matches!(id, "deepseek" | "moonshot" | "ollama" | "doubao" | "xai") {
                return None;
            }
            let fields = &plugin.manifest.config.as_ref()?.fields;
            Some((
                plugin.manifest.id.clone(),
                provider_config::resolved_values(id, fields),
            ))
        })
        .collect();
    let needs_env: HashSet<String> = candidate_values
        .iter()
        .filter(|(id, values)| needs_environment(id, values))
        .map(|(id, _)| id.clone())
        .collect();
    let env_names: Vec<&str> = candidate_values
        .iter()
        .filter(|(id, _)| needs_env.contains(id))
        .flat_map(|(id, _)| provider_env_names(id).iter().copied())
        .collect();
    let env = host_api::resolve_env_values(&env_names);
    if !env.unresolved.is_empty() {
        log::error!("provider startup detection could not inspect interactive shell credentials");
    }
    classify(candidate_values, &env, &needs_env)
}

fn classify(
    candidate_values: Vec<(String, HashMap<String, Value>)>,
    env: &host_api::ResolvedEnvValues,
    needs_env: &HashSet<String>,
) -> DetectionResult {
    let mut result = DetectionResult {
        detected_ids: Vec::new(),
        retry_ids: Vec::new(),
    };
    for (id, values) in candidate_values {
        if region_unresolved(&id, &values, env) {
            result.retry_ids.push(id);
        } else if has_credentials(&id, &values, &|name| {
            env.values.get(name).cloned().flatten()
        }) {
            result.detected_ids.push(id);
        } else if needs_env.contains(&id)
            && provider_env_names(&id)
                .iter()
                .any(|name| env.unresolved.contains(*name))
        {
            result.retry_ids.push(id);
        }
    }
    result
}

fn needs_environment(id: &str, values: &HashMap<String, Value>) -> bool {
    !has_credentials(id, values, &|_| None)
        || matches!(id, "moonshot")
            && matches!(configured(values, "region").as_deref(), None | Some("auto"))
        || matches!(id, "doubao") && configured(values, "region").is_none()
}

fn region_unresolved(
    id: &str,
    values: &HashMap<String, Value>,
    env: &host_api::ResolvedEnvValues,
) -> bool {
    match id {
        "moonshot" => {
            matches!(configured(values, "region").as_deref(), None | Some("auto"))
                && env.unresolved.contains("MOONSHOT_REGION")
        }
        "doubao" => {
            configured(values, "region").is_none() && env.unresolved.contains("VOLCENGINE_REGION")
        }
        _ => false,
    }
}

fn provider_env_names(id: &str) -> &'static [&'static str] {
    match id {
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "moonshot" => &["MOONSHOT_API_KEY", "MOONSHOT_REGION"],
        "ollama" => &["OLLAMA_CLOUD_COOKIE"],
        "doubao" => &[
            "VOLCENGINE_ACCESS_KEY_ID",
            "VOLCENGINE_SECRET_ACCESS_KEY",
            "VOLCENGINE_REGION",
        ],
        "xai" => &["XAI_MANAGEMENT_API_KEY", "XAI_TEAM_ID"],
        _ => &[],
    }
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

    #[test]
    fn shell_failure_keeps_local_and_process_credentials_but_retries_unknowns() {
        let candidates = vec![
            ("deepseek".to_string(), values(&[("apiKey", "saved-key")])),
            ("moonshot".to_string(), values(&[])),
            ("xai".to_string(), values(&[])),
        ];
        let env = host_api::ResolvedEnvValues {
            values: HashMap::from([
                (
                    "MOONSHOT_API_KEY".to_string(),
                    Some("process-key".to_string()),
                ),
                (
                    "MOONSHOT_REGION".to_string(),
                    Some("international".to_string()),
                ),
            ]),
            unresolved: HashSet::from([
                "XAI_MANAGEMENT_API_KEY".to_string(),
                "XAI_TEAM_ID".to_string(),
            ]),
        };
        let needs_env = HashSet::from(["moonshot".to_string(), "xai".to_string()]);
        let result = classify(candidates, &env, &needs_env);
        assert_eq!(result.detected_ids, ["deepseek", "moonshot"]);
        assert_eq!(result.retry_ids, ["xai"]);
        assert_eq!(
            serde_json::to_value(&result).expect("serialize detection result"),
            serde_json::json!({"detectedIds": ["deepseek", "moonshot"], "retryIds": ["xai"]})
        );
    }

    #[test]
    fn waits_for_region_lookup_before_enabling_saved_keys() {
        let candidates = vec![
            (
                "moonshot".to_string(),
                values(&[("apiKeyIntl", "saved-key"), ("region", "auto")]),
            ),
            (
                "doubao".to_string(),
                values(&[("accessKeyId", "access"), ("secretAccessKey", "secret")]),
            ),
        ];
        for (id, values) in &candidates {
            assert!(needs_environment(id, values));
        }
        let env = host_api::ResolvedEnvValues {
            values: HashMap::new(),
            unresolved: HashSet::from([
                "MOONSHOT_REGION".to_string(),
                "VOLCENGINE_REGION".to_string(),
            ]),
        };
        let needs_env = HashSet::from(["moonshot".to_string(), "doubao".to_string()]);
        let result = classify(candidates, &env, &needs_env);
        assert!(result.detected_ids.is_empty());
        assert_eq!(result.retry_ids, ["moonshot", "doubao"]);
    }

    #[test]
    fn region_environment_can_invalidate_saved_credentials() {
        let candidates = vec![
            (
                "moonshot".to_string(),
                values(&[("apiKeyIntl", "saved-key"), ("region", "auto")]),
            ),
            (
                "doubao".to_string(),
                values(&[("accessKeyId", "access"), ("secretAccessKey", "secret")]),
            ),
        ];
        let env = host_api::ResolvedEnvValues {
            values: HashMap::from([
                ("MOONSHOT_REGION".to_string(), Some("china".to_string())),
                (
                    "VOLCENGINE_REGION".to_string(),
                    Some("bad/region".to_string()),
                ),
            ]),
            unresolved: HashSet::new(),
        };
        let needs_env = HashSet::from(["moonshot".to_string(), "doubao".to_string()]);
        let result = classify(candidates, &env, &needs_env);
        assert!(result.detected_ids.is_empty());
        assert!(result.retry_ids.is_empty());
    }
}
