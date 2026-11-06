use super::*;
use serde_json::json;
fn output() -> PluginOutput {
    PluginOutput {
        provider_id: "cursor".into(),
        display_name: "Cursor".into(),
        plan: None,
        icon_url: String::new(),
        lines: vec![
            MetricLine::Progress {
                label: "Requests".into(),
                limit_resource_key: Some("requests".into()),
                used: 10.0,
                limit: 500.0,
                format: ProgressFormat::Count {
                    suffix: "requests".into(),
                },
                resets_at: None,
                period_duration_ms: None,
                color: None,
            },
            MetricLine::Progress {
                label: "On-demand".into(),
                limit_resource_key: Some("onDemand".into()),
                used: 7.0,
                limit: 50.0,
                format: ProgressFormat::Dollars,
                resets_at: None,
                period_duration_ms: None,
                color: None,
            },
        ],
    }
}
#[test]
fn shared_desktop_and_browser_fixtures_preserve_cents_and_current_user_scope() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../plugins/cursor/fixtures/unified-usage-status.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let now = OffsetDateTime::parse(case["now"].as_str().unwrap(), &Rfc3339).unwrap();
        let spend = decode(&case["summary"], &case["payload"], now)
            .ok()
            .flatten();
        if case["expected"].is_null() {
            assert!(spend.is_none(), "{}", case["name"]);
        } else {
            let spend = spend.unwrap_or_else(|| panic!("{}", case["name"]));
            assert_eq!(spend.used, case["expected"]["used"].as_f64().unwrap());
            assert_eq!(spend.limit, case["expected"]["limit"].as_f64().unwrap());
            assert_eq!(spend.start, case["expected"]["periodStart"]);
            assert_eq!(spend.reset, case["expected"]["resetsAt"]);
        }
    }
}
#[test]
fn monthly_replaces_only_one_on_demand_resource_and_keeps_binding_requests() {
    let result = apply(
        output(),
        Some(MonthlySpend {
            used: 0.93,
            limit: 10.0,
            start: "2026-10-01T00:00:00Z".into(),
            reset: "2026-11-01T00:00:00Z".into(),
        }),
    );
    assert_eq!(result.lines.iter().filter(|line| matches!(line, MetricLine::Progress {limit_resource_key:Some(key),..} if key=="onDemand")).count(), 1);
    assert!(
        matches!(&result.lines[0], MetricLine::Progress {limit_resource_key:Some(key),used,limit,..} if key=="requests" && *used==10.0 && *limit==500.0)
    );
    assert!(
        matches!(&result.lines[1], MetricLine::Progress {used,limit,period_duration_ms:Some(2678400000),..} if *used==0.93 && *limit==10.0)
    );
    let unchanged = output();
    assert_eq!(
        serde_json::to_value(apply(unchanged.clone(), None)).unwrap(),
        serde_json::to_value(unchanged).unwrap()
    );
}

#[test]
fn verified_monthly_spend_can_stand_alone_without_inventing_an_included_quota() {
    use super::super::{browser_cursor_probe, browser_cursor_weekly};

    let summary = json!({"membershipType":"unified_ultra","limitType":"user"});
    let summary_body = serde_json::to_vec(&summary).unwrap();
    assert_eq!(
        browser_cursor_probe::build_usage_summary_output(&summary_body, "Cursor", "").unwrap_err(),
        "Cursor browser usage did not include an available quota."
    );
    let now = OffsetDateTime::parse("2026-10-20T00:00:00Z", &Rfc3339).unwrap();
    let sand_body = br#"{"isUnified":true,"includedLimitZero":true}"#;
    let weekly = browser_cursor_weekly::decode_shared_weekly(sand_body, now).unwrap();
    assert!(weekly.is_none());
    let unified = decode(
        &summary,
        &json!({"availability":"available","monthlyUsage":{
            "usedCents":93,"limitCents":1000,
            "periodStart":"2026-10-01T00:00:00Z","resetsAt":"2026-11-01T00:00:00Z"
        }}),
        now,
    )
    .unwrap();
    assert!(unified.is_some());
    let recovered =
        browser_cursor_weekly::recover_summary_without_quota(&summary_body, b"{}", "Cursor", "")
            .unwrap();
    let result = apply(
        browser_cursor_weekly::finish_with_allowance(
            recovered,
            weekly,
            Ok(sand_body.to_vec()),
            now,
            "synthetic-monthly-only",
        ),
        unified,
    );
    assert_eq!(result.lines.len(), 2);
    assert!(matches!(&result.lines[0], MetricLine::Progress {
        label, limit_resource_key:Some(key), used, limit, format:ProgressFormat::Dollars, ..
    } if label == "On-demand" && key == "onDemand" && *used == 0.93 && *limit == 10.0));
    assert!(
        matches!(&result.lines[1], MetricLine::Text { label, value, .. }
        if label == "Billing Scope" && value == "Current User")
    );
}
#[test]
fn zero_cap_stays_text_and_does_not_export_a_fake_progress_resource() {
    let result = apply(
        output(),
        Some(MonthlySpend {
            used: 0.0,
            limit: 0.0,
            start: "2026-10-01T00:00:00Z".into(),
            reset: "2026-11-01T00:00:00Z".into(),
        }),
    );
    assert!(matches!(&result.lines[1], MetricLine::Text {value,..} if value=="USD 0.00"));
    assert!(!result.lines.iter().any(|line| matches!(line, MetricLine::Progress {limit_resource_key:Some(key),..} if key=="onDemand")));
}
#[test]
fn transport_is_fixed_user_scope_and_keeps_the_exact_selected_cookie() {
    let client = reqwest::blocking::Client::new();
    for cookie in [
        "WorkosCursorSessionToken=synthetic-a",
        "WorkosCursorSessionToken=synthetic-b",
    ] {
        let request = request(&client, cookie).build().unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().as_str(), URL);
        assert_eq!(request.headers()[reqwest::header::COOKIE], cookie);
        assert_eq!(request.timeout(), Some(&Duration::from_secs(5)));
    }
    // The missing limitType gate performs no request and cannot infer a user from a plan name.
    assert!(fetch(
        &client,
        br#"{"membershipType":"unified_ultra"}"#,
        "synthetic",
        OffsetDateTime::now_utc(),
        "synthetic"
    )
    .is_none());
    assert!(decode(
        &json!({"membershipType":"unified_ultra","limitType":"user"}),
        &json!({"availability":"available","monthlyUsage":{"usedCents":"NaN"}}),
        OffsetDateTime::now_utc()
    )
    .is_err());
}
