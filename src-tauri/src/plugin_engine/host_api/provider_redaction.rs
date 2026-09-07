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
    if let Some(display_text) = payload
        .get_mut("result")
        .and_then(|result| result.get_mut("displayText"))
    {
        *display_text = serde_json::Value::String("[REDACTED AMP DISPLAY TEXT]".to_string());
    }
    payload.to_string()
}

#[cfg(test)]
mod tests {
    use super::super::{redact_body, redact_http_response_body};

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
    fn openrouter_key_creator_is_redacted_without_losing_quota_diagnostics() {
        let body = r#"{"data":{"creator_user_id":"creator-private-1234567890","creatorUserId":"creator-private-0987654321","limit":100,"limit_remaining":74.5,"usage":25.5,"byok_usage":3,"include_byok_in_limit":true,"limit_reset":"monthly"}}"#;
        let redacted = redact_http_response_body("https://openrouter.ai/api/v1/key", body);
        for identity in ["creator-private-1234567890", "creator-private-0987654321"] {
            assert!(!redacted.contains(identity), "identity leaked: {redacted}");
        }
        let original: serde_json::Value = serde_json::from_str(body).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        for field in [
            "limit",
            "limit_remaining",
            "usage",
            "byok_usage",
            "include_byok_in_limit",
            "limit_reset",
        ] {
            assert_eq!(payload["data"][field], original["data"][field]);
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
}
