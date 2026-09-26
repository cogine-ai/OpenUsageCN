pub(super) fn subscription_body(body: &str) -> String {
    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return "[REDACTED SUBSCRIPTION RESPONSE]".to_string();
    };
    fn redact_ids(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                for (key, value) in object {
                    if matches!(key.as_str(), "id" | "customerId" | "customer_id") {
                        *value = serde_json::Value::String("[REDACTED]".to_string());
                    } else {
                        redact_ids(value);
                    }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(redact_ids),
            _ => {}
        }
    }
    redact_ids(&mut payload);
    payload.to_string()
}

pub(super) fn amp_body(body: &str) -> String {
    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return "[REDACTED AMP RESPONSE]".to_string();
    };
    // HTTP bodies are logged before the plugin validates the response shape.
    fn redact_display_text(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                for (key, value) in object {
                    if key == "displayText" {
                        *value =
                            serde_json::Value::String("[REDACTED AMP DISPLAY TEXT]".to_string());
                    } else {
                        redact_display_text(value);
                    }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(redact_display_text),
            _ => {}
        }
    }
    redact_display_text(&mut payload);
    payload.to_string()
}

pub(super) fn openrouter_key_body(body: &str) -> String {
    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return "[REDACTED OPENROUTER KEY RESPONSE]".to_string();
    };
    let Some(data) = payload
        .get_mut("data")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return "[REDACTED OPENROUTER KEY RESPONSE]".to_string();
    };
    for key in ["label", "organization_id", "workspace_id"] {
        if let Some(value) = data.get_mut(key) {
            if !value.is_null() {
                *value = serde_json::Value::String("[REDACTED]".to_string());
            }
        }
    }
    payload.to_string()
}

#[cfg(test)]
mod tests {
    use super::super::{redact_body, redact_http_response_body, redact_plugin_http_response_body};

    #[test]
    fn cursor_grok_usage_redacts_identity_and_preserves_quota_metadata() {
        let body = serde_json::json!({
            "userId": "synthetic-private-user-1234567890",
            "email": "synthetic-private@example.com",
            "usagePercent": 0.36,
            "includedLimitZero": false,
            "hasNonZeroIncludedLimit": true,
            "hasAvailableUsage": true,
            "usesPooledEnterpriseAllowance": false,
            "currentPeriodStart": "2026-09-10T00:00:00Z",
            "nextResetTimestampUtc": "2026-09-17T00:00:00Z",
            "sandTrialExpiresAt": null,
        });
        let redacted = redact_http_response_body(
            "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus",
            &body.to_string(),
        );
        let output: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        for (key, value) in body.as_object().unwrap() {
            if matches!(key.as_str(), "userId" | "email") {
                assert_ne!(&output[key], value, "identity must be redacted");
                assert!(!redacted.contains(value.as_str().unwrap()));
            } else {
                assert_eq!(&output[key], value, "quota metadata must remain readable");
            }
        }
    }

    #[test]
    fn opencode_v2_credentials_are_redacted_without_recognizable_prefixes() {
        let body = r#"{"credential":{"type":"key","key":"opaque-value-1234567890"},"oauth":{"access":"opaque-access-1234567890","refresh":"opaque-refresh-1234567890"},"usagePercent":0.5}"#;
        let redacted = redact_body(body);
        for secret in [
            "opaque-value-1234567890",
            "opaque-access-1234567890",
            "opaque-refresh-1234567890",
        ] {
            assert!(!redacted.contains(secret), "credential leaked: {redacted}");
        }
        assert!(redacted.contains(r#""usagePercent":0.5"#));
    }

    #[test]
    fn credential_redaction_handles_json_whitespace_and_escaped_quotes() {
        let body = r#"{"key" : "opaque\"private-middle-1234567890", "access": "value\"private-middle-1234567890"}"#;
        let redacted = redact_body(body);
        assert!(
            !redacted.contains("private-middle"),
            "credential leaked: {redacted}"
        );
        assert!(serde_json::from_str::<serde_json::Value>(&redacted).is_ok());
    }

    #[test]
    fn short_json_credentials_with_escaped_quotes_are_fully_redacted() {
        let body = r#"{"key":"abc\"def\"ghi","usagePercent":0.5}"#;
        let redacted = redact_http_response_body("https://example.com/usage", body);
        let payload: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        assert_eq!(payload["key"], "[REDACTED]");
        assert_eq!(payload["usagePercent"], 0.5);
    }

    #[test]
    fn short_json_credentials_with_unicode_escapes_are_fully_redacted() {
        for body in [
            r#"{"access":"\u0061\u0062\u0063\u0064\u0065\u0066\u0067\u0068"}"#,
            r#"{"access":"\ud83d\ude80\u4f60\u597d"}"#,
        ] {
            let redacted = redact_http_response_body("https://example.com/usage", body);
            let payload: serde_json::Value = serde_json::from_str(&redacted).unwrap();
            assert_eq!(payload["access"], "[REDACTED]");
        }
    }

    #[test]
    fn long_json_credentials_preserve_only_decoded_diagnostic_edges() {
        let body = r#"{"refresh":"\u0061\u0062\u0063\u0064-middle-\u0077\u0078\u0079\u007a"}"#;
        let redacted = redact_http_response_body("https://example.com/usage", body);
        let payload: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        assert_eq!(payload["refresh"], "abcd...wxyz");
    }

    #[test]
    fn invalid_json_credential_escapes_are_fully_redacted() {
        let body = r#"{"key":"abc\qprivate-suffix","usagePercent":0.5}"#;
        let redacted = redact_http_response_body("https://example.com/usage", body);
        let payload: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        assert_eq!(payload["key"], "[REDACTED]");
        assert_eq!(payload["usagePercent"], 0.5);
    }

    #[test]
    fn openrouter_key_identity_is_redacted_without_losing_quota_diagnostics() {
        let body = serde_json::json!({"data": {
            "creator_user_id": "creator-private-1234567890",
            "creatorUserId": "creator-private-0987654321",
            "label": "sk-or-v1-au7...890",
            "organization_id": "org-private-1234567890",
            "workspace_id": "0df9e665-d932-5740-b2c7-b52af166bc11",
            "limit": 100,
            "limit_remaining": 74.5,
            "usage": 25.5,
            "byok_usage": 3,
            "include_byok_in_limit": true,
            "limit_reset": "monthly"
        }});
        for url in [
            "https://openrouter.ai/api/v1/key",
            "https://openrouter.ai/api/v1/key#details",
            "https://openrouter.ai/api/v1/key?include=usage#details",
            "https://gateway.example/openrouter/v1/key",
        ] {
            let redacted = redact_plugin_http_response_body("openrouter", url, &body.to_string());
            for identity in [
                "creator-private-1234567890",
                "creator-private-0987654321",
                "sk-or-v1-au7...890",
                "org-private-1234567890",
                "0df9e665-d932-5740-b2c7-b52af166bc11",
            ] {
                assert!(!redacted.contains(identity), "identity leaked: {redacted}");
            }
            let payload: serde_json::Value = serde_json::from_str(&redacted).unwrap();
            for field in ["label", "organization_id", "workspace_id"] {
                assert_eq!(payload["data"][field], "[REDACTED]");
            }
            for field in [
                "limit",
                "limit_remaining",
                "usage",
                "byok_usage",
                "include_byok_in_limit",
                "limit_reset",
            ] {
                assert_eq!(payload["data"][field], body["data"][field]);
            }
        }
    }

    #[test]
    fn openrouter_key_redaction_is_scoped_and_malformed_bodies_fail_closed() {
        let body = r#"{"data":{"label":"Personal key","organization_id":"private-org","workspace_id":"private-workspace"}}"#;
        for (plugin_id, url) in [
            ("other", "https://openrouter.ai/api/v1/key"),
            ("openrouter", "https://openrouter.ai/api/v1/credits"),
        ] {
            assert_eq!(redact_plugin_http_response_body(plugin_id, url, body), body);
        }
        assert_eq!(
            redact_plugin_http_response_body(
                "openrouter",
                "https://openrouter.ai/api/v1/key",
                r#"{"data":{"label":"private-key""#,
            ),
            "[REDACTED OPENROUTER KEY RESPONSE]"
        );
        for body in [
            r#"{"error":"private-key-label"}"#,
            r#"{"data":"private-key-label"}"#,
        ] {
            assert_eq!(
                redact_plugin_http_response_body(
                    "openrouter",
                    "https://openrouter.ai/api/v1/key",
                    body
                ),
                "[REDACTED OPENROUTER KEY RESPONSE]"
            );
        }
    }

    #[test]
    fn subscription_identifiers_are_redacted_without_losing_plan_diagnostics() {
        let body = r#"{"data":[{"id":"subscription-1234567890","customerId":"customer-1234567890","productName":"GLM Coding Pro","nextRenewTime":"2026-10-01T00:00:00Z","nested":{"id":123456789012345}}]}"#;
        let redacted =
            redact_http_response_body("https://api.z.ai/api/biz/subscription/list?probe=1", body);
        for identity in [
            "subscription-1234567890",
            "customer-1234567890",
            "123456789012345",
        ] {
            assert!(!redacted.contains(identity), "identity leaked: {redacted}");
        }
        assert!(redacted.contains("GLM Coding Pro"));
        assert!(redacted.contains("2026-10-01T00:00:00Z"));
    }

    #[test]
    fn subscription_redaction_is_scoped_and_invalid_payloads_are_not_logged() {
        let body = r#"{"id":"diagnostic-1234567890","value":12}"#;
        assert_eq!(
            redact_http_response_body("https://example.com/usage", body),
            body
        );
        let malformed = r#"{"data":[{"id":"private-subscription-1234567890""#;
        assert_eq!(
            redact_http_response_body("https://api.z.ai/api/biz/subscription/list", malformed),
            "[REDACTED SUBSCRIPTION RESPONSE]"
        );
    }

    #[test]
    fn amp_balance_text_hides_embedded_identity_only_for_the_amp_endpoint() {
        let body = r#"{"ok":true,"result":{"displayText":"Signed in as member-private@example.com (private-login)\nSubscription Megawatt: 97% other usage and 100% orb usage remaining"}}"#;
        let redacted = redact_http_response_body("https://ampcode.com/api/internal", body);
        assert!(!redacted.contains("member-private@example.com"));
        assert!(!redacted.contains("private-login"));
        assert!(redacted.contains("[REDACTED AMP DISPLAY TEXT]"));
        assert!(redacted.contains(r#""ok":true"#));
        assert_eq!(
            redact_http_response_body("https://example.com/api/internal", body),
            body
        );
        assert_eq!(
            redact_http_response_body(
                "https://ampcode.com/api/internal",
                "Signed in as private-login"
            ),
            "[REDACTED AMP RESPONSE]"
        );
    }

    #[test]
    fn amp_display_text_is_redacted_at_any_object_or_array_path_only_for_amp() {
        for body in [
            r#"{"ok":true,"result":{"groups":[{"displayText":"Signed in as fixture-private@example.com (fixture-login)"}]},"count":2}"#,
            r#"[{"result":{"displayText":"Signed in as fixture-private@example.com (fixture-login)"}},{"nested":{"displayText":"fixture-login"},"count":2}]"#,
            r#"{"ok":true,"result":{"displayText":"usual text","details":[{"nested":{"displayText":"Signed in as fixture-private@example.com (fixture-login)"}}]},"count":2}"#,
        ] {
            let redacted = redact_http_response_body("https://ampcode.com/api/internal", body);
            assert!(
                !redacted.contains("fixture-private"),
                "identity leaked: {redacted}"
            );
            assert!(
                !redacted.contains("fixture-login"),
                "identity leaked: {redacted}"
            );
            assert!(redacted.contains("[REDACTED AMP DISPLAY TEXT]"));
            assert!(redacted.contains(r#""count":2"#));
            assert!(serde_json::from_str::<serde_json::Value>(&redacted).is_ok());
            assert_eq!(
                redact_http_response_body("https://example.com/api/internal", body),
                body
            );
        }
    }
}
