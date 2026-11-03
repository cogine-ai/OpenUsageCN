use super::*;
use crate::provider_accounts::browser_cursor_probe::{
    build_legacy_output, build_usage_summary_output,
};

fn now() -> OffsetDateTime {
    OffsetDateTime::parse("2026-09-16T00:00:00Z", &Rfc3339).unwrap()
}

fn weekly() -> MetricLine {
    decode_shared_weekly(
        br#"{"isUnified":true,"includedLimitZero":false,"usagePercent":0,
        "nextResetTimestampUtc":"2026-09-20T00:00:00Z"}"#,
        now(),
    )
    .unwrap()
    .unwrap()
}

#[test]
fn shared_js_rust_protocol_fixtures_match_without_plan_name_inference() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../plugins/cursor/fixtures/shared-weekly.json"
    ))
    .unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let raw = serde_json::to_vec(&fixture["sand"]).unwrap();
        let line = decode_shared_weekly(&raw, now()).ok().flatten();
        match fixture["weeklyUsed"].as_f64() {
            Some(expected) => match line.unwrap() {
                MetricLine::Progress {
                    label,
                    limit_resource_key,
                    used,
                    limit,
                    format,
                    period_duration_ms,
                    resets_at,
                    ..
                } => {
                    assert_eq!(label, "Shared Weekly Usage", "{}", fixture["name"]);
                    assert_eq!(limit_resource_key.as_deref(), Some("weekly"));
                    assert_eq!(used, expected);
                    assert_eq!(limit, 100.0);
                    assert!(matches!(format, ProgressFormat::Percent));
                    assert_eq!(period_duration_ms, Some(604_800_000));
                    assert!(resets_at.is_some());
                }
                _ => panic!("expected weekly progress"),
            },
            None => assert!(line.is_none(), "{}", fixture["name"]),
        }
    }
}

#[test]
fn malformed_or_incomplete_weekly_never_becomes_zero_usage() {
    for body in [b"not json".as_slice(), b"[]", b"null",
        br#"{"isUnified":true,"includedLimitZero":"false","hasNonZeroIncludedLimit":true}"#,
        br#"{"isUnified":true,"includedLimitZero":false,"usagePercent":"0","nextResetTimestampUtc":"2026-09-20T00:00:00Z"}"#,
        br#"{"isUnified":true,"includedLimitZero":false,"nextResetTimestampUtc":"2026-09-20T00:00:00Z"}"#,
    ] {
        assert!(decode_shared_weekly(body, now()).ok().flatten().is_none());
    }
}

#[test]
fn paid_weekly_ignores_trial_and_midweek_grant_start() {
    let body = br#"{"isUnified":true,"includedLimitZero":false,"usagePercent":42.25,
        "sandTrialExpiresAt":"2026-09-22T00:00:00Z","currentPeriodStart":"2026-09-19T12:00:00Z",
        "nextResetTimestampUtc":"2026-09-20T00:00:00Z"}"#;
    match decode_shared_weekly(body, now()).unwrap().unwrap() {
        MetricLine::Progress {
            period_duration_ms,
            used,
            ..
        } => {
            assert_eq!(period_duration_ms, Some(604_800_000));
            assert_eq!(used, 42.25);
        }
        _ => panic!("weekly progress"),
    }
}

#[test]
fn unified_enterprise_replaces_monthly_and_grok_but_retains_spending_and_identity() {
    let mut output = build_usage_summary_output(
        br#"{"membershipType":"enterprise",
        "individualUsage":{"plan":{"used":4615,"limit":4615,"totalPercentUsed":100,
            "autoPercentUsed":62.860238353196095,"apiPercentUsed":0},
            "onDemand":{"used":447,"limit":1000,"enabled":true}}}"#,
        "Cursor",
        "fixture-icon",
    )
    .unwrap();
    output.lines.push(MetricLine::Text {
        label: "Grok Bot".into(),
        value: "Unavailable".into(),
        color: None,
        subtitle: None,
    });
    assert!(apply_shared_weekly(&mut output, weekly()));
    assert_eq!(output.plan.as_deref(), Some("Enterprise"));
    assert_eq!(output.icon_url, "fixture-icon");
    assert_eq!(output.lines.len(), 2);
    assert!(
        matches!(&output.lines[1], MetricLine::Progress { limit_resource_key: Some(key), used, .. }
        if key == "onDemand" && *used == 4.47)
    );
}

#[test]
fn explicit_legacy_request_quota_remains_binding() {
    let mut output = build_legacy_output(
        br#"{"gpt-4":{"numRequestsTotal":200,"maxRequestUsage":500}}"#,
        Some("enterprise"),
        "Cursor",
        "",
    )
    .unwrap();
    assert!(!apply_shared_weekly(&mut output, weekly()));
    assert_eq!(output.lines.len(), 1);
    assert!(
        matches!(&output.lines[0], MetricLine::Progress { limit_resource_key: Some(key), .. } if key == "requests")
    );
}

#[test]
fn browser_finalizer_does_not_relabel_shared_pool_when_request_quota_is_binding() {
    let output = build_legacy_output(
        br#"{"gpt-4":{"numRequestsTotal":200,"maxRequestUsage":500}}"#,
        Some("enterprise"),
        "Cursor",
        "",
    )
    .unwrap();
    let body = br#"{"isUnified":true,"includedLimitZero":false,"usagePercent":25,
        "nextResetTimestampUtc":"2026-09-20T00:00:00Z"}"#;
    let weekly = decode_shared_weekly(body, now()).unwrap();
    let output = finish_with_allowance(output, weekly, Ok(body.to_vec()), now(), "fixture");
    assert_eq!(output.lines.len(), 1);
    assert!(matches!(&output.lines[0], MetricLine::Progress {
        limit_resource_key: Some(key), used, limit, ..
    } if key == "requests" && *used == 200.0 && *limit == 500.0));
}

#[test]
fn valid_no_quota_summary_can_recover_only_after_confirmed_absent_requests() {
    let summary = br#"{"membershipType":"unified_ultra","individualUsage":{
        "onDemand":{"enabled":true,"used":447,"limit":1000}}}"#;
    let mut output =
        recover_summary_without_quota(summary, b"{}", "Cursor", "fixture-icon").unwrap();
    assert!(apply_shared_weekly(&mut output, weekly()));
    assert_eq!(output.lines.len(), 2);
    assert!(
        matches!(&output.lines[1], MetricLine::Progress { limit_resource_key: Some(key), used, .. }
        if key == "onDemand" && *used == 4.47)
    );
    for legacy in [
        b"null".as_slice(),
        b"[]",
        b"not json",
        br#"{"error":"forbidden"}"#,
        br#"{"gpt-4":{"maxRequestUsage":0}}"#,
        br#"{"gpt-4":null}"#,
    ] {
        assert!(recover_summary_without_quota(summary, legacy, "Cursor", "").is_none());
    }
    for invalid in [
        b"{}".as_slice(),
        b"[]",
        br#"{"error":"account unavailable"}"#,
    ] {
        assert!(recover_summary_without_quota(invalid, b"{}", "Cursor", "").is_none());
    }
}
