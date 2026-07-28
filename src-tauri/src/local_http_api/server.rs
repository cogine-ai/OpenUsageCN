use super::cache::{
    cache_state, enabled_plugin_ids_ordered, enabled_snapshots_ordered, health_cache_state,
};
use super::cors::cors_headers;
use super::limits::envelope_from_state;
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

    if path == "/v1/limits" {
        return match method {
            "GET" => handle_get_limits_collection(origin),
            "OPTIONS" => response_no_content(origin),
            _ => response_method_not_allowed(origin),
        };
    }

    if let Some(provider_id) = path.strip_prefix("/v1/limits/") {
        if !provider_id.is_empty() && !provider_id.contains('/') {
            return match method {
                "GET" => handle_get_limits_single(provider_id, origin),
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
        let mut state = cache_state().lock().expect("cache state poisoned");
        enabled_snapshots_ordered(&mut state)
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

fn handle_get_limits_collection(origin: Option<&str>) -> String {
    let envelope = {
        let mut state = cache_state().lock().expect("cache state poisoned");
        let provider_ids = enabled_plugin_ids_ordered(&mut state);
        envelope_from_state(&provider_ids, &state)
    };
    match serde_json::to_string(&envelope) {
        Ok(body) => response_json(origin, 200, "OK", &body),
        Err(e) => {
            log::error!("failed to serialize local HTTP API limits collection response: {e}");
            response_internal_error(origin)
        }
    }
}

fn handle_get_limits_single(provider_id: &str, origin: Option<&str>) -> String {
    let envelope = {
        let state = cache_state().lock().expect("cache state poisoned");
        if !state.known_plugin_ids.iter().any(|id| id == provider_id) {
            return response_not_found(origin, "provider_not_found");
        }
        if !state.snapshots.contains_key(provider_id) && !state.errors.contains_key(provider_id) {
            return response_no_content(origin);
        }
        envelope_from_state(&[provider_id.to_string()], &state)
    };
    match serde_json::to_string(&envelope) {
        Ok(body) => response_json(origin, 200, "OK", &body),
        Err(e) => {
            log::error!(
                "failed to serialize local HTTP API limits response for provider {provider_id}: {e}"
            );
            response_internal_error(origin)
        }
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
#[path = "server_tests.rs"]
mod tests;
