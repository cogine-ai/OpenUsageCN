pub(super) fn response_body(plugin: &str, path: &str, body: &str) -> Option<String> {
    // These private billing/auth payloads can contain identities and secondary model keys,
    // including fields unknown to the generic JSON scrubber. Never log partial bodies.
    if matches!(plugin, "claude-platform" | "litellm" | "siliconflow" | "workbuddy" | "trae-cn" | "muse") {
        return Some("[REDACTED PROVIDER BILLING RESPONSE]".into());
    }
    let endpoint = path.split('?').next().unwrap_or(path);
    if plugin == "kiro" && endpoint == "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken" {
        return Some("[REDACTED PROVIDER AUTH RESPONSE]".into());
    }
    let private_usage = match plugin {
        "cursor" => endpoint.ends_with("/api/usage-summary") || endpoint.ends_with("/api/dashboard/v2/usage-status"),
        "claude" => endpoint.ends_with("/api/oauth/usage"),
        "synthetic" => endpoint == "https://api.synthetic.new/v2/quotas",
        "zai" => endpoint == "https://api.z.ai/api/biz/customer-package-reset/list",
        "kiro" => endpoint == "https://codewhisperer.us-east-1.amazonaws.com/" || endpoint == "https://q.eu-central-1.amazonaws.com/" || endpoint.ends_with("/getUsageLimits"),
        _ => false,
    };
    if private_usage { return Some("[REDACTED PROVIDER USAGE RESPONSE]".into()); }
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
    fn improved_provider_responses_hide_new_identity_and_coupon_fields_even_when_malformed() {
        for (provider, url) in [
            ("cursor", "https://cursor.com/api/usage-summary"),
            ("cursor", "https://cursor.com/api/dashboard/v2/usage-status?scope=user"),
            ("claude", "https://api.anthropic.com/api/oauth/usage"),
            ("synthetic", "https://api.synthetic.new/v2/quotas"),
            ("kiro", "https://codewhisperer.us-east-1.amazonaws.com/"),
            ("kiro", "https://q.eu-central-1.amazonaws.com/"),
            ("zai", "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL"),
        ] {
            for body in [r#"{"recordId":123,"userInfo":{"email":"private@example.invalid"},"scope":{"model":{"id":"private-model"}}}"#, "malformed private-token-private@example.invalid"] {
                assert_eq!(redact_plugin_http_response_body(provider, url, body), "[REDACTED PROVIDER USAGE RESPONSE]");
            }
        }
        assert!(is_env_var_allowed_for_plugin("kiro", "KIRO_DATA_DIR"));
        assert!(is_env_var_allowed_for_plugin("kiro", "XDG_DATA_HOME"));
        assert!(!is_env_var_allowed_for_plugin("cursor", "KIRO_DATA_DIR"));
        assert!(!is_env_var_allowed_for_plugin("zai", "KIRO_DATA_DIR"));
    }

    #[test]
    fn desktop_kiro_usage_request_and_response_hide_profile_identity_and_credentials() {
        let arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/synthetic-private-profile";
        let mut url = reqwest::Url::parse("https://q.us-east-1.amazonaws.com/getUsageLimits").unwrap();
        url.query_pairs_mut()
            .append_pair("origin", "AI_EDITOR")
            .append_pair("profileArn", arn)
            .append_pair("resourceType", "AGENTIC_REQUEST");
        let request_log = format!("[plugin:kiro] HTTP GET {}", redact_url(url.as_str()));
        for private in [arn, "123456789012", "synthetic-private-profile"] {
            assert!(!request_log.contains(private), "{request_log}");
        }
        assert!(request_log.contains("/getUsageLimits?origin=AI_EDITOR"));
        assert!(request_log.contains("resourceType=AGENTIC_REQUEST"));

        for body in [
            r#"{"profileArn":"private-profile","userInfo":{"email":"private@example.invalid","userId":"private-user"},"accessToken":"synthetic-private-access","refreshToken":"synthetic-private-refresh","usageBreakdownList":[{"currentUsageWithPrecision":42.5}]}"#,
            "malformed private-profile private@example.invalid synthetic-private-access",
        ] {
            assert_eq!(
                redact_plugin_http_response_body("kiro", url.as_str(), body),
                "[REDACTED PROVIDER USAGE RESPONSE]"
            );
        }
    }

    #[test]
    fn desktop_kiro_refresh_responses_are_hidden_without_parsing_credentials() {
        let url = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
        for body in [
            r#"{"accessToken":"synthetic-private-access","refreshToken":"synthetic-private-refresh","profileArn":"private-profile","futureCredential":"unknown-private-token"}"#,
            r#"{"accessToken":"synthetic-private-access","refreshToken":"synthetic-private-refresh","profileArn":"private-profile","futureCredential":"unknown-private-token""#,
            "malformed synthetic-private-access synthetic-private-refresh private-profile unknown-private-token",
        ] {
            assert_eq!(
                redact_plugin_http_response_body("kiro", url, body),
                "[REDACTED PROVIDER AUTH RESPONSE]"
            );
        }
    }

    #[test]
    fn desktop_kiro_refresh_rule_does_not_capture_other_providers_or_paths() {
        let url = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
        assert!(super::response_body("cursor", url, "unrelated response").is_none());
        for url in [
            "https://prod.us-east-1.auth.desktop.kiro.dev/refreshTokenExtra",
            "https://example.invalid/refreshToken",
        ] {
            assert!(super::response_body("kiro", url, "unrelated response").is_none());
        }
    }
    #[test]
    fn new_provider_request_identifiers_are_not_logged() {
        let logged = redact_url("https://platform.claude.com/api/organizations/private-org/prepaid/credits");
        assert!(!logged.contains("private-org"));
        assert!(logged.ends_with("/prepaid/credits"));
        let logged = redact_url("https://proxy.example/team/info?team_id=private-team&user_id=private-user&start_date=2026-11-01");
        assert!(!logged.contains("private-team"));
        assert!(!logged.contains("private-user"));
        assert!(logged.contains("start_date=2026-11-01"));
    }
    #[test]
    fn new_billing_providers_suppress_every_response_including_malformed_identity_data() {
        for provider in ["claude-platform", "litellm", "siliconflow", "workbuddy", "trae-cn", "muse"] {
            for body in [r#"{"UserEmail":"private@example.invalid","Result":{"Token":"secret-device"},"api_key":"secret-model"}"#, "broken secret-model private@example.invalid"] {
                assert_eq!(redact_plugin_http_response_body(provider, "https://example.invalid/private", body), "[REDACTED PROVIDER BILLING RESPONSE]");
            }
        }
        for (provider, name) in [("claude-platform", "CLAUDE_PLATFORM_COOKIE"), ("litellm", "LITELLM_API_KEY"), ("siliconflow", "SILICONFLOW_API_KEY"), ("workbuddy", "WORKBUDDY_COOKIE"), ("trae-cn", "TRAE_CN_COOKIE")] {
            assert!(is_env_var_allowed_for_plugin(provider, name));
            assert!(!is_env_var_allowed_for_plugin("muse", name));
            assert!(!is_env_var_allowed_for_plugin("ollama", name));
        }
    }

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
