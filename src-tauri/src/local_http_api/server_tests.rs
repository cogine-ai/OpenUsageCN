use super::super::cache::{CachedPluginSnapshot, cache_state};
use super::super::limits::{LimitCatalogResource, ProviderLimitCatalog};
use super::*;
use crate::plugin_engine::manifest::LimitResourceKind;
use crate::plugin_engine::runtime::{MetricLine, ProgressFormat};
use serial_test::serial;
use std::net::Shutdown;
use std::thread;

fn make_snapshot(id: &str, name: &str) -> CachedPluginSnapshot {
    CachedPluginSnapshot {
        provider_id: id.to_string(),
        display_name: name.to_string(),
        plan: Some("Pro".to_string()),
        lines: vec![],
        started_at: "2026-03-26T08:15:00Z".to_string(),
        fetched_at: "2026-03-26T08:15:30Z".to_string(),
    }
}

fn response_for_request(request: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
    let addr = listener.local_addr().expect("test listener addr");
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept test connection");
        let permit = ConnectionLimiter::new(1)
            .acquire()
            .expect("test connection permit");
        handle_connection(stream, permit);
    });

    let mut client = TcpStream::connect(addr).expect("connect test client");
    client
        .write_all(request.as_bytes())
        .expect("write test request");
    client
        .shutdown(Shutdown::Write)
        .expect("shutdown test request");

    let mut response = String::new();
    client
        .read_to_string(&mut response)
        .expect("read test response");
    server.join().expect("join test server");
    response
}

#[test]
#[serial]
fn route_health_returns_service_and_cache_state() {
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["claude".to_string(), "codex".to_string()];
        state.snapshots.clear();
    }

    let resp = route("GET", "/health", None, None);

    assert!(resp.starts_with("HTTP/1.1 200"));
    assert!(resp.contains(r#""status":"ok""#));
    assert!(resp.contains(r#""apiVersion":"v1""#));
    assert!(resp.contains(r#""known":2"#));
    assert!(resp.contains(r#""cached":0"#));
    assert!(resp.contains(r#""ready":false"#));
}

#[test]
fn route_rejects_non_loopback_host() {
    let resp = route("GET", "/v1/usage", Some("evil.example"), None);

    assert!(resp.starts_with("HTTP/1.1 403"));
    assert!(resp.contains(r#""error":"forbidden_host""#));
}

#[test]
fn route_allows_loopback_hosts() {
    let resp = route("GET", "/v1/usage", Some("127.0.0.1:6736"), None);

    assert!(resp.starts_with("HTTP/1.1 200"));
}

#[test]
fn route_get_usage_returns_200() {
    let resp = route("GET", "/v1/usage", None, None);
    assert!(resp.starts_with("HTTP/1.1 200"));
}

#[test]
fn route_get_limits_returns_machine_contract() {
    let resp = route("GET", "/v1/limits", None, None);
    assert!(resp.starts_with("HTTP/1.1 200"));
    assert!(resp.contains(r#""schema":"openusage.limits.v1""#));
}

#[test]
fn route_unknown_limits_provider_returns_404() {
    let resp = route("GET", "/v1/limits/not-a-provider", None, None);
    assert!(resp.starts_with("HTTP/1.1 404"));
    assert!(resp.contains(r#""error":"provider_not_found""#));
}

#[test]
#[serial]
fn route_known_uncached_limits_provider_returns_204() {
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["claude".to_string()];
        state.snapshots.clear();
        state.errors.clear();
    }

    let resp = route("GET", "/v1/limits/claude", None, None);
    assert!(resp.starts_with("HTTP/1.1 204"));
}

#[test]
fn route_unknown_path_returns_404() {
    let resp = route("GET", "/v2/something", None, None);
    assert!(resp.starts_with("HTTP/1.1 404"));
}

#[test]
fn route_post_returns_405() {
    let resp = route("POST", "/v1/usage", None, None);
    assert!(resp.starts_with("HTTP/1.1 405"));
}

#[test]
fn route_options_returns_204_with_loopback_cors() {
    let resp = route("OPTIONS", "/v1/usage", None, Some("http://localhost:3000"));
    assert!(resp.starts_with("HTTP/1.1 204"));
    assert!(resp.contains("Access-Control-Allow-Origin: http://localhost:3000"));
}

#[test]
fn route_omits_cors_origin_for_public_origin() {
    let resp = route(
        "GET",
        "/v1/usage",
        Some("127.0.0.1:6736"),
        Some("https://evil.example"),
    );

    assert!(resp.starts_with("HTTP/1.1 200"));
    assert!(!resp.contains("Access-Control-Allow-Origin"));
}

#[test]
fn route_allows_tauri_app_origin() {
    let resp = route("GET", "/health", None, Some("tauri://localhost"));

    assert!(resp.starts_with("HTTP/1.1 200"));
    assert!(resp.contains("Access-Control-Allow-Origin: tauri://localhost"));
}

#[test]
#[serial]
fn route_unknown_provider_returns_404() {
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["claude".to_string()];
        state.snapshots.clear();
    }

    let resp = route("GET", "/v1/usage/nonexistent", None, None);
    assert!(resp.starts_with("HTTP/1.1 404"));
    assert!(resp.contains("provider_not_found"));
}

#[test]
#[serial]
fn route_known_uncached_provider_returns_204() {
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["claude".to_string()];
        state.snapshots.clear();
    }

    let resp = route("GET", "/v1/usage/claude", None, None);
    assert!(resp.starts_with("HTTP/1.1 204"));
}

#[test]
#[serial]
fn route_known_cached_provider_returns_200() {
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["claude".to_string()];
        state
            .snapshots
            .insert("claude".to_string(), make_snapshot("claude", "Claude"));
    }

    let resp = route("GET", "/v1/usage/claude", None, None);
    assert!(resp.starts_with("HTTP/1.1 200"));
    assert!(resp.contains("fetchedAt"));
}

#[test]
fn route_options_on_provider_returns_204() {
    let resp = route("OPTIONS", "/v1/usage/claude", None, None);
    assert!(resp.starts_with("HTTP/1.1 204"));
    assert!(resp.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
}

#[test]
fn response_json_includes_content_type_and_common_cors_headers() {
    let resp = response_json(Some("http://127.0.0.1:1420"), 200, "OK", "[]");
    assert!(resp.contains("Access-Control-Allow-Origin: http://127.0.0.1:1420"));
    assert!(resp.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
    assert!(resp.contains("Content-Type: application/json; charset=utf-8"));
}

#[test]
fn connection_limiter_rejects_above_capacity_and_releases_on_drop() {
    let limiter = ConnectionLimiter::new(2);
    let first = limiter.acquire().expect("first permit");
    let second = limiter.acquire().expect("second permit");

    assert!(limiter.acquire().is_none());
    assert_eq!(limiter.active_count(), 2);

    drop(first);

    let third = limiter.acquire().expect("permit after release");
    assert_eq!(limiter.active_count(), 2);

    drop(second);
    drop(third);
    assert_eq!(limiter.active_count(), 0);
}

#[test]
fn response_service_unavailable_returns_503_json() {
    let resp = response_service_unavailable();

    assert!(resp.starts_with("HTTP/1.1 503"));
    assert!(resp.contains(r#""error":"server_busy""#));
    assert!(resp.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
    assert!(!resp.contains("Access-Control-Allow-Origin"));
}

#[test]
fn response_internal_error_returns_500_json() {
    let resp = response_internal_error(Some("http://localhost:3000"));

    assert!(resp.starts_with("HTTP/1.1 500"));
    assert!(resp.contains(r#""error":"internal_error""#));
    assert!(resp.contains("Access-Control-Allow-Origin: http://localhost:3000"));
}

#[test]
fn request_parser_strips_query_string_from_path() {
    let resp =
        response_for_request("GET /v1/usage?cache=false HTTP/1.1\r\nHost: 127.0.0.1:6736\r\n\r\n");

    assert!(resp.starts_with("HTTP/1.1 200"));
}

#[test]
#[serial]
fn request_parser_strips_trailing_slash_from_provider_path() {
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["claude".to_string()];
        state.snapshots.clear();
    }

    let resp =
        response_for_request("GET /v1/usage/claude/ HTTP/1.1\r\nHost: 127.0.0.1:6736\r\n\r\n");

    assert!(
        resp.starts_with("HTTP/1.1 204"),
        "unexpected response: {resp}"
    );
}

#[test]
fn route_rejects_nested_provider_paths() {
    let resp = route("GET", "/v1/usage/claude/extra", None, None);

    assert!(resp.starts_with("HTTP/1.1 404"));
    assert!(resp.contains("not_found"));
}

#[test]
fn route_allows_ipv6_loopback_host() {
    let resp = route("GET", "/health", Some("[::1]:6736"), None);

    assert!(resp.starts_with("HTTP/1.1 200"));
}

#[test]
fn route_rejects_ipv6_host_without_allowed_port() {
    let resp = route("GET", "/health", Some("[::1]:9999"), None);

    assert!(resp.starts_with("HTTP/1.1 403"));
    assert!(resp.contains(r#""error":"forbidden_host""#));
}

#[test]
fn header_value_is_case_insensitive() {
    let request = "GET /health HTTP/1.1\r\nHoSt: 127.0.0.1:6736\r\n\r\n";

    assert_eq!(
        header_value(request, "host").as_deref(),
        Some("127.0.0.1:6736")
    );
}

#[test]
#[serial]
fn route_limits_provider_with_probe_error_returns_200_and_redacted_message() {
    let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["codex".to_string()];
        state.snapshots.clear();
        state.limit_catalog.clear();
        state.errors.clear();
        state
            .errors
            .insert("codex".to_string(), format!("refresh failed: token={jwt}"));
    }

    let resp = route("GET", "/v1/limits/codex", None, None);

    assert!(resp.starts_with("HTTP/1.1 200"), "unexpected response: {resp}");
    assert!(resp.contains(r#""errors""#));
    assert!(
        !resp.contains(jwt),
        "probe error leaked JWT in HTTP response: {resp}"
    );
}

#[test]
#[serial]
fn route_limits_provider_with_partial_resources_returns_200_and_resource_errors() {
    let mut snapshot = make_snapshot("codex", "Codex");
    snapshot.lines = vec![
        MetricLine::Progress {
            label: "Session".to_string(),
            limit_resource_key: Some("session".to_string()),
            used: 34.0,
            limit: 100.0,
            format: ProgressFormat::Percent,
            resets_at: Some("2026-07-14T09:00:00Z".to_string()),
            period_duration_ms: Some(18_000_000),
            color: None,
        },
        MetricLine::Progress {
            label: "Requests".to_string(),
            limit_resource_key: None,
            used: 12.0,
            limit: 100.0,
            format: ProgressFormat::Count {
                suffix: "req".to_string(),
            },
            resets_at: None,
            period_duration_ms: None,
            color: None,
        },
    ];
    let catalog = ProviderLimitCatalog {
        provider_id: "codex".to_string(),
        resources: vec![
            LimitCatalogResource {
                key: "session".to_string(),
                metric_label: "Session".to_string(),
                kind: LimitResourceKind::Consumption,
                count_unit: None,
            },
            LimitCatalogResource {
                key: "requests".to_string(),
                metric_label: "Requests".to_string(),
                kind: LimitResourceKind::Consumption,
                count_unit: None,
            },
        ],
    };

    {
        let mut state = cache_state().lock().unwrap();
        state.known_plugin_ids = vec!["codex".to_string()];
        state.snapshots.insert("codex".to_string(), snapshot);
        state.errors.clear();
        state.limit_catalog.insert("codex".to_string(), catalog);
    }

    let resp = route("GET", "/v1/limits/codex", None, None);

    assert!(resp.starts_with("HTTP/1.1 200"), "unexpected response: {resp}");
    assert!(resp.contains(r#""session""#));
    assert!(resp.contains("count resource is missing a stable unit"));
}
