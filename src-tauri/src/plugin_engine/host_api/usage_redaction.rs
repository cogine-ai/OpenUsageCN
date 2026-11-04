pub(super) fn response_body(plugin: &str, path: &str, body: &str) -> Option<String> {
    if plugin == "codex"
        && (path.ends_with("/wham/analytics/daily-workspace-usage-counts")
            || path.ends_with("/wham/usage/daily-workspace-user-token-usage-breakdown")
            || path.ends_with("/wham/usage/daily-workspace-user-credit-usage"))
    {
        return Some("[REDACTED CODEX REPORT RESPONSE]".into());
    }
    if plugin == "minimax"
        && path == "https://www.minimax.cn/backend/account/token_plan/remains_percent"
    {
        return Some("[REDACTED MINIMAX WEB RESPONSE]".into());
    }
    if plugin == "perplexity" && path == "https://www.perplexity.ai/rest/billing/credits" {
        return Some("[REDACTED PERPLEXITY SUBSCRIPTION RESPONSE]".into());
    }
    if plugin == "openrouter" && (path.ends_with("/keys") || path.ends_with("/activity")) {
        return Some(openrouter_body(body));
    }
    None
}

pub(super) fn openrouter_body(body: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(body) else {
        return "[REDACTED OPENROUTER USAGE RESPONSE]".into();
    };
    fn scrub(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                for (key, value) in object {
                    if matches!(
                        key.as_str(),
                        "hash"
                            | "label"
                            | "name"
                            | "creator_user_id"
                            | "creatorUserId"
                            | "organization_id"
                            | "organizationId"
                            | "workspace_id"
                            | "workspaceId"
                            | "user_id"
                            | "userId"
                            | "endpoint_id"
                            | "endpointId"
                            | "api_key_hash"
                            | "guardrail_id"
                            | "budget_id"
                    ) {
                        if !value.is_null() {
                            *value = serde_json::Value::String("[REDACTED]".into());
                        }
                    } else {
                        scrub(value);
                    }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(scrub),
            _ => {}
        }
    }
    scrub(&mut value);
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::super::{
        is_env_var_allowed_for_plugin, redact_plugin_http_response_body, redact_url,
    };

    #[test]
    fn ollama_key_environment_is_private_to_its_plugin() {
        assert!(is_env_var_allowed_for_plugin("ollama", "OLLAMA_API_KEY"));
        for other in ["codex", "cursor", "openrouter", "minimax"] {
            assert!(!is_env_var_allowed_for_plugin(other, "OLLAMA_API_KEY"));
        }
    }

    #[test]
    fn identity_rich_new_sources_are_suppressed_even_on_malformed_responses() {
        for (plugin, url) in [
            ("ollama", "https://ollama.com/api/me"),
            ("ollama", "https://ollama.com/api/balance"),
            (
                "codex",
                "https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts?group_by=day",
            ),
            (
                "codex",
                "https://chatgpt.com/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown",
            ),
            (
                "codex",
                "https://chatgpt.com/backend-api/wham/usage/daily-workspace-user-credit-usage?breakdown=model",
            ),
            (
                "minimax",
                "https://www.minimax.cn/backend/account/token_plan/remains_percent",
            ),
            (
                "perplexity",
                "https://www.perplexity.ai/rest/billing/credits?version=2.18",
            ),
        ] {
            for body in [
                r#"{"Email":"private-member@example.com","account":"private-account"}"#,
                "broken private-member@example.com",
            ] {
                let logged = redact_plugin_http_response_body(plugin, url, body);
                assert!(!logged.contains("private-member"));
                assert!(!logged.contains("private-account"));
                assert!(logged.starts_with("[REDACTED"));
            }
        }
    }

    #[test]
    fn management_lists_and_activity_hide_identifiers_but_keep_usage() {
        let body = r#"{"data":[{"hash":"private-key-hash","label":"Private Key","workspace_id":"private-workspace","creator_user_id":12345,"endpoint_id":"private-endpoint","guardrail_id":"private-rule","budget_id":"private-budget","usage":42.5,"requests":12}]}"#;
        for suffix in ["keys?offset=0", "activity?date=2026-11-01"] {
            let url = format!("https://openrouter.ai/api/v1/{suffix}");
            let logged = redact_plugin_http_response_body("openrouter", &url, body);
            assert!(!logged.contains("private-"));
            assert!(!logged.contains("Private Key"));
            assert!(!logged.contains("12345"));
            let value: serde_json::Value = serde_json::from_str(&logged).unwrap();
            assert_eq!(value["data"][0]["usage"], 42.5);
            assert_eq!(value["data"][0]["requests"], 12);
            assert!(
                redact_plugin_http_response_body("openrouter", &url, "broken private-value")
                    .starts_with("[REDACTED")
            );
        }
        assert_eq!(
            redact_plugin_http_response_body(
                "other",
                "https://example.com/activity",
                r#"{"usage":42.5}"#
            ),
            r#"{"usage":42.5}"#
        );
    }

    #[test]
    fn workspace_and_key_filters_do_not_leak_in_urls() {
        let logged = redact_url(
            "https://openrouter.ai/api/v1/activity?workspace_id=private-workspace-123456&api_key_hash=private-key-hash-654321&date=2026-11-01",
        );
        assert!(!logged.contains("private-workspace-123456"));
        assert!(!logged.contains("private-key-hash-654321"));
        assert!(logged.contains("date=2026-11-01"));
    }

    #[test]
    fn antigravity_project_identity_is_hidden_on_both_assist_hosts() {
        for host in [
            "cloudcode-pa.googleapis.com",
            "daily-cloudcode-pa.googleapis.com",
        ] {
            let logged = redact_plugin_http_response_body(
                "antigravity",
                &format!("https://{host}/v1internal:loadCodeAssist"),
                r#"{"cloudaicompanionProject":{"id":"private-project"},"currentTier":{"id":"pro"}}"#,
            );
            assert!(!logged.contains("private-project"));
            assert!(logged.contains("pro"));
        }
        let request = super::super::redact_body(r#"{"project":"private-project-1234567890"}"#);
        assert!(!request.contains("private-project-1234567890"));
    }

    #[test]
    fn endpoint_redaction_keeps_generic_secret_protection_and_numeric_usage() {
        let body = r#"{"data":[{"hash":"private-key-hash","api_key":"synthetic-api-key-private","access_token":"synthetic-token-private","email":"private-reader@example.invalid","usage":42.5,"requests":12}]}"#;
        for endpoint in ["keys", "activity"] {
            let logged = redact_plugin_http_response_body(
                "openrouter",
                &format!("https://openrouter.ai/api/v1/{endpoint}"),
                body,
            );
            for secret in [
                "private-key-hash",
                "synthetic-api-key-private",
                "synthetic-token-private",
                "private-reader@example.invalid",
            ] {
                assert!(
                    !logged.contains(secret),
                    "{endpoint} leaked {secret}: {logged}"
                );
            }
            let parsed: serde_json::Value = serde_json::from_str(&logged).unwrap();
            assert_eq!(parsed["data"][0]["usage"], 42.5);
            assert_eq!(parsed["data"][0]["requests"], 12);
        }
    }
}
