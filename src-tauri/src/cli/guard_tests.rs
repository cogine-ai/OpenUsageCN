use super::*;
use crate::local_http_api::limits::{LIMITS_SCHEMA, LimitsError, LimitsProvider, LimitsResource};
use std::collections::BTreeMap;

fn reading(remaining: f64) -> LimitsRead {
    let now = OffsetDateTime::now_utc();
    let expires = now + time::Duration::minutes(5);
    let reset = now + time::Duration::hours(2);
    LimitsRead {
        refresh_failed: false,
        missing_snapshot: false,
        envelope: LimitsEnvelope {
            schema: LIMITS_SCHEMA,
            generated_at: now.format(&Rfc3339).unwrap(),
            providers: BTreeMap::from([(
                "codex".into(),
                LimitsProvider {
                    display_name: "Codex".into(),
                    plan: None,
                    fetched_at: now.format(&Rfc3339).unwrap(),
                    expires_at: expires.format(&Rfc3339).unwrap(),
                    stale: false,
                    resources: BTreeMap::from([(
                        "session".into(),
                        LimitsResource {
                            kind: LimitResourceKind::Consumption,
                            unit: "percent".into(),
                            used: Some(100.0 - remaining),
                            available: None,
                            limit: Some(100.0),
                            remaining: Some(remaining),
                            utilization: Some(1.0 - remaining / 100.0),
                            resets_at: Some(reset.format(&Rfc3339).unwrap()),
                            window_seconds: Some(18000.0),
                        },
                    )]),
                },
            )]),
            errors: vec![],
        },
    }
}

fn invoke(args: &[&str], read: LimitsRead) -> (i32, serde_json::Value, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = execute(
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        |provider, _| {
            assert_eq!(provider, Some("codex"));
            Ok(read)
        },
        &mut out,
        &mut err,
    );
    (
        code,
        serde_json::from_slice(&out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

#[test]
fn output_and_exit_code_agree_at_both_sides_of_the_inclusive_threshold() {
    for (remaining, code, decision) in [
        (21.0, 0, "allowed"),
        (20.0, 0, "allowed"),
        (19.0, 1, "blocked"),
    ] {
        let (actual, json, err) = invoke(&["codex", "--min-remaining", "20"], reading(remaining));
        assert_eq!(actual, code);
        assert_eq!(json["decision"], decision);
        assert_eq!(json["schema"], "openusage.guard.v1");
        assert_eq!(json["remainingPercent"], remaining);
        assert!(err.is_empty());
    }
}

#[test]
fn exhausted_quota_is_blocked_and_an_explicit_zero_threshold_is_respected() {
    assert_eq!(invoke(&["codex"], reading(0.0)).0, 1);
    assert_eq!(
        invoke(&["codex", "--min-remaining", "0"], reading(0.0)).0,
        0
    );
}

#[test]
fn stale_or_reset_windows_never_allow_a_task_on_an_old_reading() {
    let mut stale = reading(90.0);
    stale.envelope.providers.get_mut("codex").unwrap().stale = true;
    let (_, json, _) = invoke(&["codex"], stale);
    assert_eq!(json["reason"], "stale");

    let mut expired = reading(90.0);
    expired
        .envelope
        .providers
        .get_mut("codex")
        .unwrap()
        .expires_at = "2000-01-01T00:00:00Z".into();
    assert_eq!(invoke(&["codex"], expired).1["reason"], "stale");

    let mut reset = reading(90.0);
    reset
        .envelope
        .providers
        .get_mut("codex")
        .unwrap()
        .resources
        .get_mut("session")
        .unwrap()
        .resets_at = Some("2000-01-01T00:00:00Z".into());
    let (code, json, _) = invoke(&["codex"], reset);
    assert_eq!(code, 3);
    assert_eq!(json["reason"], "window_reset");
    assert!(json["remainingPercent"].is_null());
}

#[test]
fn missing_snapshot_window_and_refresh_failures_are_unknown() {
    let mut missing = reading(90.0);
    missing.envelope.providers.clear();
    assert_eq!(invoke(&["codex"], missing).1["reason"], "no_snapshot");
    assert_eq!(
        invoke(&["codex", "--window", "weekly"], reading(90.0)).1["reason"],
        "window_unavailable"
    );
    let mut failed = reading(90.0);
    failed.refresh_failed = true;
    let (code, json, _) = invoke(&["codex"], failed);
    assert_eq!(code, 3);
    assert_eq!(json["decision"], "unknown");
    let mut error = reading(90.0);
    error.envelope.errors.push(LimitsError {
        provider_id: "codex".into(),
        message: "private diagnostic".into(),
    });
    let (_, json, _) = invoke(&["codex"], error);
    assert_eq!(json["reason"], "refresh_failed");
    assert!(!json.to_string().contains("private diagnostic"));
}

#[test]
fn nonnumeric_and_unbounded_resources_are_unknown() {
    for value in [f64::NAN, f64::INFINITY, -1.0, 101.0] {
        assert_eq!(
            invoke(&["codex"], reading(value)).1["reason"],
            "invalid_data"
        );
    }
    let mut unbounded = reading(90.0);
    unbounded
        .envelope
        .providers
        .get_mut("codex")
        .unwrap()
        .resources
        .get_mut("session")
        .unwrap()
        .limit = None;
    assert_eq!(invoke(&["codex"], unbounded).1["reason"], "invalid_data");
}

#[test]
fn invalid_arguments_fail_before_reading_any_provider() {
    for args in [
        vec![],
        vec!["codex", "claude"],
        vec!["codex", "--force", "--force"],
        vec!["codex", "--min-remaining"],
        vec!["codex", "--min-remaining", "NaN"],
        vec!["codex", "--min-remaining", "101"],
        vec!["codex", "--min-remaining", "-1"],
        vec!["codex", "--window", "monthly"],
        vec!["codex", "--window"],
        vec!["codex", "--window", "weekly", "--window", "session"],
        vec!["codex", "--other"],
    ] {
        let mut out = vec![];
        let mut err = vec![];
        let code = execute(
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            |_, _| panic!("invalid arguments must not collect data"),
            &mut out,
            &mut err,
        );
        assert_eq!(code, 2, "{args:?}");
        assert!(out.is_empty());
        assert!(!err.is_empty());
    }
}

#[test]
fn force_and_window_selection_reach_the_existing_reader() {
    let mut read = reading(90.0);
    let resources = &mut read.envelope.providers.get_mut("codex").unwrap().resources;
    let session = resources.remove("session").unwrap();
    resources.insert("weekly".into(), session);
    let mut out = vec![];
    let mut err = vec![];
    let code = execute(
        &["--force", "codex", "--window", "weekly"].map(String::from),
        |provider, force| {
            assert_eq!(provider, Some("codex"));
            assert!(force);
            Ok(read)
        },
        &mut out,
        &mut err,
    );
    assert_eq!(code, 0);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out).unwrap()["window"],
        "weekly"
    );
}

#[test]
fn reader_configuration_errors_produce_json_but_unknown_provider_is_invalid_input() {
    for (error, expected) in [
        (LimitsReadError::NoDataDirectory, 3),
        (LimitsReadError::NoProviderPlugins, 3),
        (LimitsReadError::UnknownProvider("codex".into()), 2),
    ] {
        let mut out = vec![];
        let mut err = vec![];
        assert_eq!(
            execute(&["codex".into()], |_, _| Err(error), &mut out, &mut err),
            expected
        );
        assert!(!err.is_empty());
        if expected == 3 {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&out).unwrap()["reason"],
                "read_failed"
            );
        } else {
            assert!(out.is_empty());
        }
    }
}
