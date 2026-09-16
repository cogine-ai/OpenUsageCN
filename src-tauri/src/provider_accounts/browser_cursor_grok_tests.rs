use super::browser_cursor_grok::{append_grok_usage, decode_grok_usage, grok_request};
use super::browser_cursor_probe::build_usage_summary_output;
use crate::plugin_engine::runtime::MetricLine;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn now() -> OffsetDateTime {
    OffsetDateTime::parse("2026-09-16T00:00:00Z", &Rfc3339).unwrap()
}
fn decode(value: Value) -> Result<Option<MetricLine>, &'static str> {
    decode_grok_usage(&serde_json::to_vec(&value).unwrap(), now())
}

#[test]
fn browser_grok_uses_bound_cookie_fixed_post_and_short_timeout() {
    let client = reqwest::blocking::Client::new();
    let request = grok_request(&client, "WorkosCursorSessionToken=synthetic-bound-session")
        .build()
        .unwrap();
    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        request.url().as_str(),
        "https://cursor.com/api/dashboard/get-sand-usage-status"
    );
    assert_eq!(
        request.headers()[reqwest::header::COOKIE],
        "WorkosCursorSessionToken=synthetic-bound-session"
    );
    assert!(
        !request
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION)
    );
    assert_eq!(request.timeout(), Some(&std::time::Duration::from_secs(5)));
    assert_eq!(request.body().unwrap().as_bytes(), Some(b"{}".as_slice()));
}

#[test]
fn browser_grok_keeps_zero_exhausted_and_clamps_overage() {
    for (percent, expected) in [(0.0, 0.0), (100.0, 100.0), (125.0, 100.0)] {
        let line = decode(
            json!({"usagePercent":percent,"includedLimitZero":false,"hasAvailableUsage":false}),
        )
        .unwrap()
        .unwrap();
        assert!(
            matches!(line, MetricLine::Progress { used, limit: 100.0, resets_at: None, period_duration_ms: None, .. } if used == expected)
        );
    }
}

#[test]
fn browser_grok_paid_reset_uses_actual_interval_and_no_assumed_week() {
    let line = decode(json!({"usagePercent":20,"hasNonZeroIncludedLimit":true,"currentPeriodStart":"2026-09-14T00:00:00Z","nextResetTimestampUtc":"2026-09-20T00:00:00Z"})).unwrap().unwrap();
    assert!(
        matches!(line, MetricLine::Progress { resets_at: Some(end), period_duration_ms: Some(duration), .. } if end == "2026-09-20T00:00:00Z" && duration == 6*24*60*60*1000)
    );
    let line = decode(json!({"usagePercent":20,"hasNonZeroIncludedLimit":true,"nextResetTimestampUtc":"2026-09-20T00:00:00Z"})).unwrap().unwrap();
    assert!(matches!(
        line,
        MetricLine::Progress {
            resets_at: Some(_),
            period_duration_ms: None,
            ..
        }
    ));
}

#[test]
fn browser_grok_trial_ignores_recurring_reset_and_expired_trial_is_hidden() {
    for end in ["2026-09-17T00:00:00Z", "2026-09-15T00:00:00Z"] {
        let line = decode(json!({"usagePercent":15,"includedLimitZero":true,"sandTrialExpiresAt":end,"currentPeriodStart":"2026-09-14T00:00:00Z","nextResetTimestampUtc":"2026-09-20T00:00:00Z"})).unwrap();
        if end == "2026-09-17T00:00:00Z" {
            assert!(matches!(
                line,
                Some(MetricLine::Progress {
                    resets_at: None,
                    period_duration_ms: None,
                    ..
                })
            ));
        } else {
            assert!(line.is_none());
        }
    }
}

#[test]
fn browser_grok_hides_explicit_ineligible_and_rejects_unknown_or_invalid_data() {
    for value in [
        json!({"usesPooledEnterpriseAllowance":true}),
        json!({"includedLimitZero":true}),
        json!({"hasNonZeroIncludedLimit":false}),
    ] {
        assert!(decode(value).unwrap().is_none());
    }
    for percent in [Value::Null, json!(true), json!("20"), json!(-1)] {
        assert!(decode(json!({"usagePercent":percent,"includedLimitZero":false})).is_err());
    }
    assert!(decode(json!({"usagePercent":20})).is_err());
}

#[test]
fn browser_grok_failure_preserves_primary_and_has_friendly_visible_status() {
    for result in [
        Err("request failed"),
        Ok(b"not JSON".to_vec()),
        Ok(b"{}".to_vec()),
    ] {
        let mut output = build_usage_summary_output(br#"{"individualUsage":{"plan":{"totalPercentUsed":42,"autoPercentUsed":10,"apiPercentUsed":90}}}"#, "Cursor", "").unwrap();
        append_grok_usage(&mut output, result, now(), "synthetic-correlation");
        assert!(matches!(
            &output.lines[0],
            MetricLine::Progress { used: 42.0, .. }
        ));
        assert!(
            matches!(&output.lines[1], MetricLine::Progress { label, limit_resource_key: Some(key), .. } if label == "Cursor Models" && key == "autoUsage")
        );
        assert!(
            matches!(&output.lines[2], MetricLine::Progress { label, limit_resource_key: Some(key), .. } if label == "Other Models" && key == "apiUsage")
        );
        assert!(
            matches!(&output.lines[3], MetricLine::Text { label, value, .. } if label == "Grok Bot" && value == "Unavailable")
        );
    }
}
