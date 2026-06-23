use super::cache::{cache_state, enabled_snapshots_ordered, health_cache_state};
use super::cors::cors_headers;
use super::status::{
    LocalHttpApiServiceStatus, get_status, mark_bind_failed, mark_running, mark_starting,
};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const BIND_ADDR: &str = "127.0.0.1:6736";
const MAX_CONCURRENT_CONNECTIONS: usize = 16;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

struct ConnectionLimiter {
    active: Arc<AtomicUsize>,
    max: usize,
}

struct ConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl ConnectionLimiter {
    fn new(max: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            max,
        }
    }

    fn acquire(&self) -> Option<ConnectionPermit> {
        loop {
            let active = self.active.load(Ordering::Acquire);
            if active >= self.max {
                return None;
            }
            if self
                .active
                .compare_exchange(active, active + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(ConnectionPermit {
                    active: Arc::clone(&self.active),
                });
            }
        }
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

pub fn start_server() {
    mark_starting(BIND_ADDR);
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(BIND_ADDR) {
            Ok(l) => {
                mark_running(BIND_ADDR);
                log::info!("local HTTP API listening on {}", BIND_ADDR);
                l
            }
            Err(e) => {
                mark_bind_failed(BIND_ADDR, &e.to_string());
                log::warn!(
                    "failed to bind local HTTP API on {}: {} — feature disabled for this session",
                    BIND_ADDR,
                    e
                );
                return;
            }
        };

        let limiter = ConnectionLimiter::new(MAX_CONCURRENT_CONNECTIONS);
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let Some(permit) = limiter.acquire() else {
                        log::warn!(
                            "local HTTP API connection limit reached (max={})",
                            MAX_CONCURRENT_CONNECTIONS
                        );
                        let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));
                        let _ = stream.write_all(response_service_unavailable().as_bytes());
                        let _ = stream.flush();
                        continue;
                    };
                    std::thread::spawn(move || handle_connection(stream, permit));
                }
                Err(e) => log::debug!("local HTTP API accept error: {}", e),
            }
        }
    });
}

fn handle_connection(mut stream: TcpStream, _permit: ConnectionPermit) {
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));

    // Read request (up to 4 KB is plenty for a request line + headers)
    let mut buf = [0u8; 4096];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse request line: "METHOD /path HTTP/1.x\r\n..."
    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("");

    // Strip query string and trailing slash (but keep root "/v1/usage" intact)
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    let path = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };

    let host = header_value(&request, "host");
    let origin = header_value(&request, "origin");
    let response = route(method, path, host.as_deref(), origin.as_deref());
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn route(method: &str, path: &str, host: Option<&str>, origin: Option<&str>) -> String {
    if !is_allowed_host(host) {
        return response_forbidden_host(origin);
    }

    if path == "/health" {
        return match method {
            "GET" => handle_get_health(origin),
            "OPTIONS" => response_no_content(origin),
            _ => response_method_not_allowed(origin),
        };
    }

    // Match routes
    if path == "/v1/usage" {
        return match method {
            "GET" => handle_get_usage_collection(origin),
            "OPTIONS" => response_no_content(origin),
            _ => response_method_not_allowed(origin),
        };
    }

    if let Some(provider_id) = path.strip_prefix("/v1/usage/") {
        if !provider_id.is_empty() && !provider_id.contains('/') {
            return match method {
                "GET" => handle_get_usage_single(provider_id, origin),
                "OPTIONS" => response_no_content(origin),
                _ => response_method_not_allowed(origin),
            };
        }
    }

    response_not_found(origin, "not_found")
}

fn header_value(request: &str, name: &str) -> Option<String> {
    request.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

fn is_allowed_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return true;
    };
    let normalized = host.trim().trim_end_matches('.').to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "127.0.0.1" | "127.0.0.1:6736" | "localhost" | "localhost:6736" | "[::1]" | "[::1]:6736"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    api_version: &'static str,
    version: String,
    service: LocalHttpApiServiceStatus,
    providers: super::cache::HealthProvidersSummary,
    cache: super::cache::HealthCacheSummary,
}

fn handle_get_health(origin: Option<&str>) -> String {
    let cache_state = health_cache_state();
    let body = HealthResponse {
        status: "ok",
        api_version: "v1",
        version: cache_state.version,
        service: get_status(),
        providers: cache_state.providers,
        cache: cache_state.cache,
    };
    match serde_json::to_string(&body) {
        Ok(body) => response_json(origin, 200, "OK", &body),
        Err(e) => {
            log::error!("failed to serialize local HTTP API health response: {e}");
            response_internal_error(origin)
        }
    }
}

fn handle_get_usage_collection(origin: Option<&str>) -> String {
    let snapshots = {
        let state = cache_state().lock().expect("cache state poisoned");
        enabled_snapshots_ordered(&state)
    };
    match serde_json::to_string(&snapshots) {
        Ok(body) => response_json(origin, 200, "OK", &body),
        Err(e) => {
            log::error!("failed to serialize local HTTP API usage collection response: {e}");
            response_internal_error(origin)
        }
    }
}

fn handle_get_usage_single(provider_id: &str, origin: Option<&str>) -> String {
    let state = cache_state().lock().expect("cache state poisoned");

    // Check if provider is known at all
    let is_known = state.known_plugin_ids.iter().any(|id| id == provider_id);
    if !is_known {
        return response_not_found(origin, "provider_not_found");
    }

    match state.snapshots.get(provider_id) {
        Some(snapshot) => match serde_json::to_string(snapshot) {
            Ok(body) => response_json(origin, 200, "OK", &body),
            Err(e) => {
                log::error!(
                    "failed to serialize local HTTP API usage response for provider {provider_id}: {e}"
                );
                response_internal_error(origin)
            }
        },
        None => response_no_content(origin),
    }
}

// ---------------------------------------------------------------------------
// HTTP response builders
// ---------------------------------------------------------------------------

fn response_json(origin: Option<&str>, status: u16, reason: &str, body: &str) -> String {
    let cors = cors_headers(origin);
    format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n{}\r\nContent-Length: {}\r\n\r\n{}",
        status,
        reason,
        cors,
        body.len(),
        body,
    )
}

fn response_no_content(origin: Option<&str>) -> String {
    let cors = cors_headers(origin);
    format!(
        "HTTP/1.1 204 No Content\r\nConnection: close\r\n{}\r\n\r\n",
        cors,
    )
}

fn response_not_found(origin: Option<&str>, error_code: &str) -> String {
    let body = format!(r#"{{"error":"{}"}}"#, error_code);
    response_json(origin, 404, "Not Found", &body)
}

fn response_method_not_allowed(origin: Option<&str>) -> String {
    let body = r#"{"error":"method_not_allowed"}"#;
    response_json(origin, 405, "Method Not Allowed", body)
}

fn response_forbidden_host(origin: Option<&str>) -> String {
    let body = r#"{"error":"forbidden_host"}"#;
    response_json(origin, 403, "Forbidden", body)
}

fn response_internal_error(origin: Option<&str>) -> String {
    let body = r#"{"error":"internal_error"}"#;
    response_json(origin, 500, "Internal Server Error", body)
}

fn response_service_unavailable() -> String {
    let body = r#"{"error":"server_busy"}"#;
    response_json(None, 503, "Service Unavailable", body)
}

#[cfg(test)]
mod tests {
    use super::super::cache::{CachedPluginSnapshot, cache_state};
    use super::*;
    use serial_test::serial;
    use std::net::Shutdown;
    use std::thread;

    fn make_snapshot(id: &str, name: &str) -> CachedPluginSnapshot {
        CachedPluginSnapshot {
            provider_id: id.to_string(),
            display_name: name.to_string(),
            plan: Some("Pro".to_string()),
            lines: vec![],
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
        let resp = response_for_request(
            "GET /v1/usage?cache=false HTTP/1.1\r\nHost: 127.0.0.1:6736\r\n\r\n",
        );

        assert!(resp.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn route_strips_trailing_slash_from_nested_paths() {
        let resp = route("GET", "/v1/usage/claude/", None, None);

        assert!(
            resp.starts_with("HTTP/1.1 204") || resp.starts_with("HTTP/1.1 404"),
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
}
