use super::browser_cursor_probe::{build_legacy_output, build_usage_summary_output};
use crate::plugin_engine::runtime::{MetricLine, ProgressFormat};

#[test]
fn browser_usage_summary_preserves_current_cursor_quota_semantics() {
    let output = build_usage_summary_output(
        br#"{
          "membershipType":"pro",
          "billingCycleStart":"2026-05-23T10:27:04.000Z",
          "billingCycleEnd":"2026-06-23T10:27:04.000Z",
          "individualUsage":{
            "plan":{
              "used":388,
              "limit":2000,
              "totalPercentUsed":19.4,
              "autoPercentUsed":12.5,
              "apiPercentUsed":6.9
            },
            "onDemand":{"enabled":true,"used":450,"limit":1000}
          }
        }"#,
        "Cursor",
        "data:image/svg+xml;base64,cursor",
    )
    .expect("summary output");

    assert_eq!(output.plan.as_deref(), Some("Pro"));
    assert_eq!(output.lines.len(), 4);
    match &output.lines[0] {
        MetricLine::Progress {
            label,
            used,
            limit,
            format,
            resets_at,
            period_duration_ms,
            ..
        } => {
            assert_eq!(label, "Total usage");
            assert_eq!((*used, *limit), (19.4, 100.0));
            assert!(matches!(format, ProgressFormat::Percent));
            assert_eq!(resets_at.as_deref(), Some("2026-06-23T10:27:04.000Z"));
            assert_eq!(*period_duration_ms, Some(31 * 24 * 60 * 60 * 1_000));
        }
        other => panic!("expected total usage progress, got {other:?}"),
    }
    match &output.lines[3] {
        MetricLine::Progress {
            label,
            used,
            limit,
            format,
            ..
        } => {
            assert_eq!(label, "On-demand");
            assert_eq!((*used, *limit), (4.5, 10.0));
            assert!(matches!(format, ProgressFormat::Dollars));
        }
        other => panic!("expected on-demand progress, got {other:?}"),
    }
    assert_eq!(output.icon_url, "data:image/svg+xml;base64,cursor");
}

#[test]
fn browser_team_summary_uses_dollar_projection_and_exact_plan_mapping() {
    let output = build_usage_summary_output(
        br#"{
          "membershipType":"pro_plus",
          "individualUsage":{"plan":{"used":1250,"limit":5000}},
          "teamUsage":{"pooled":{"enabled":true,"used":10000,"limit":20000}}
        }"#,
        "Cursor",
        "",
    )
    .expect("team output");

    assert_eq!(output.plan.as_deref(), Some("Pro+"));
    match &output.lines[0] {
        MetricLine::Progress {
            used,
            limit,
            format,
            ..
        } => {
            assert_eq!((*used, *limit), (25.0, 100.0));
            assert!(matches!(format, ProgressFormat::Percent));
        }
        other => panic!("expected plan progress, got {other:?}"),
    }
}

#[test]
fn codex_plan_aliases_do_not_leak_into_cursor_browser_labels() {
    let output = build_usage_summary_output(
        br#"{"membershipType":"pro_lite","individualUsage":{"plan":{"used":10,"limit":100}}}"#,
        "Cursor",
        "",
    )
    .expect("cursor output");

    assert_eq!(output.plan.as_deref(), Some("Pro Lite"));
}

#[test]
fn browser_legacy_request_usage_remains_available_when_summary_has_no_plan_quota() {
    let output = build_legacy_output(
        br#"{"gpt-4":{"numRequests":200,"numRequestsTotal":240,"maxRequestUsage":500},"startOfMonth":"2026-05-23"}"#,
        Some("enterprise"),
        "Cursor",
        "",
    )
    .expect("legacy output");

    assert_eq!(output.plan.as_deref(), Some("Enterprise"));
    match &output.lines[0] {
        MetricLine::Progress {
            label,
            used,
            limit,
            format,
            resets_at,
            period_duration_ms,
            ..
        } => {
            assert_eq!(label, "Requests");
            assert_eq!((*used, *limit), (240.0, 500.0));
            assert_eq!(
                *resets_at, None,
                "startOfMonth does not prove a billing end"
            );
            assert_eq!(*period_duration_ms, None);
            assert!(matches!(
                format,
                ProgressFormat::Count { suffix } if suffix == "requests"
            ));
        }
        other => panic!("expected requests progress, got {other:?}"),
    }
}

#[test]
fn malformed_browser_quota_data_fails_instead_of_returning_success_shaped_output() {
    assert!(build_usage_summary_output(br#"{"membershipType":"pro"}"#, "Cursor", "").is_err());
    assert!(
        build_usage_summary_output(
            br#"{"individualUsage":{"plan":{"limit":-1}}}"#,
            "Cursor",
            ""
        )
        .is_err()
    );
    assert!(
        build_legacy_output(br#"{"gpt-4":{"maxRequestUsage":0}}"#, None, "Cursor", "").is_err()
    );
}

/// Exercise the actual HTTP/status path without provider credentials or external requests.
fn fetch_local_browser_response(status: u16, endpoint_class: &str) -> Result<Vec<u8>, String> {
    use super::browser_cursor_probe::FixedBrowserCursorProbe;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        started.elapsed() < Duration::from_secs(5),
                        "fixture server timed out"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => panic!("fixture server could not accept a request"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let length = stream.read(&mut buffer).unwrap();
            assert!(length > 0 && request.len() < 8192);
            request.extend_from_slice(&buffer[..length]);
        }
        let body = br#"{"error":"server-response-secret"}"#;
        let mut response = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(body);
        stream.write_all(&response).unwrap();
    });
    let probe = FixedBrowserCursorProbe::with_test_client(
        reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap(),
    );
    let result = probe.get_json(
        &format!("http://{address}/{endpoint_class}"),
        "WorkosCursorSessionToken=synthetic-cookie-secret",
        endpoint_class,
        "synthetic-correlation",
    );
    server.join().unwrap();
    result
}

#[test]
fn browser_http_401_requires_reauthentication_without_echoing_secrets() {
    for endpoint in ["usage-summary", "legacy-usage"] {
        let error = fetch_local_browser_response(401, endpoint).unwrap_err();
        assert_eq!(
            error,
            "The selected Cursor browser session expired. Scan it again."
        );
        assert!(!error.contains("secret"));
    }
}

#[test]
fn browser_http_403_reports_access_denied_without_expiring_the_session() {
    for endpoint in ["usage-summary", "legacy-usage"] {
        let error = fetch_local_browser_response(403, endpoint).unwrap_err();
        assert_eq!(
            error,
            "Cursor browser usage access was denied (HTTP 403). Check the account's permissions."
        );
        assert!(!error.contains("expired") && !error.contains("Scan"));
        assert!(!error.contains("secret"));
    }
}

#[test]
fn successful_browser_http_response_preserves_the_body_for_quota_decoding() {
    assert_eq!(
        fetch_local_browser_response(200, "usage-summary").unwrap(),
        br#"{"error":"server-response-secret"}"#,
    );
}
