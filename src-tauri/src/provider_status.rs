use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::AppState;

const STATUS_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_STATUS_RESPONSE_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub level: ProviderStatusLevel,
    pub description: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderStatusLevel {
    Operational,
    Degraded,
    Outage,
}

#[derive(Debug, Deserialize)]
struct StatuspageResponse {
    status: StatuspageStatus,
    #[serde(default)]
    page: Option<StatuspagePage>,
}

#[derive(Debug, Deserialize)]
struct StatuspageStatus {
    indicator: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct StatuspagePage {
    #[serde(default)]
    updated_at: Option<String>,
}

fn parse_statuspage_status(body: &[u8]) -> Result<ProviderStatus, String> {
    let response: StatuspageResponse = serde_json::from_slice(body)
        .map_err(|error| format!("invalid Statuspage response: {error}"))?;
    let level = match response.status.indicator.as_str() {
        "none" => ProviderStatusLevel::Operational,
        "minor" => ProviderStatusLevel::Degraded,
        "major" | "critical" => ProviderStatusLevel::Outage,
        indicator => return Err(format!("unsupported Statuspage indicator '{indicator}'")),
    };

    let description = response.status.description.trim().to_string();
    if description.is_empty() {
        return Err("Statuspage response has an empty description".to_string());
    }

    Ok(ProviderStatus {
        level,
        description,
        updated_at: response.page.and_then(|page| page.updated_at),
    })
}

fn build_status_client(https_only: bool) -> Result<reqwest::blocking::Client, String> {
    let mut client_builder = reqwest::blocking::Client::builder()
        .timeout(STATUS_REQUEST_TIMEOUT)
        .connect_timeout(STATUS_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("OpenUsageCN/provider-status");
    if https_only {
        client_builder = client_builder.https_only(true);
    }
    if let Some(resolved) = crate::config::get_resolved_proxy() {
        client_builder = client_builder.proxy(resolved.proxy.clone());
    }
    client_builder
        .build()
        .map_err(|error| format!("failed to build status client: {error}"))
}

fn fetch_statuspage_status(api_url: &str) -> Result<ProviderStatus, String> {
    let client = build_status_client(true)?;
    let response = client
        .get(api_url)
        .send()
        .map_err(|error| format!("status request failed: {error}"))?;
    let response_status = response.status();
    if !response_status.is_success() {
        return Err(format!(
            "status request returned HTTP {}",
            response_status.as_u16()
        ));
    }

    let mut body = Vec::new();
    response
        .take(MAX_STATUS_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("failed to read status response: {error}"))?;
    if body.len() as u64 > MAX_STATUS_RESPONSE_BYTES {
        return Err("status response exceeded 1 MB".to_string());
    }

    parse_statuspage_status(&body)
}

#[tauri::command]
pub async fn get_provider_status(
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
) -> Result<ProviderStatus, String> {
    let status_page = {
        let locked = state.lock().map_err(|error| error.to_string())?;
        let plugin = locked
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == plugin_id)
            .ok_or_else(|| format!("unknown plugin '{plugin_id}'"))?;
        plugin
            .manifest
            .status_page
            .clone()
            .ok_or_else(|| format!("plugin '{plugin_id}' does not declare statusPage"))?
    };

    let result =
        tauri::async_runtime::spawn_blocking(move || fetch_statuspage_status(&status_page.api_url))
            .await
            .map_err(|error| format!("status task failed: {error}"))?;

    match result {
        Ok(status) => {
            log::debug!("provider status {}: {:?}", plugin_id, status.level);
            Ok(status)
        }
        Err(error) => {
            log::warn!("provider status {} check failed: {}", plugin_id, error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::ffi::OsString;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    struct EnvVarGuard {
        name: &'static str,
        old: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(name: &'static str, value: &str) -> Self {
            let old = std::env::var_os(name);
            // SAFETY: this serial test restores every changed variable before returning.
            unsafe { std::env::set_var(name, value) };
            Self { name, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = self.old.take() {
                // SAFETY: this restores the process environment captured by the guard.
                unsafe { std::env::set_var(self.name, value) };
            } else {
                // SAFETY: the variable was absent before this serial test.
                unsafe { std::env::remove_var(self.name) };
            }
        }
    }

    fn status_response(indicator: &str) -> Vec<u8> {
        format!(
            r#"{{
                "page": {{ "updated_at": "2026-07-14T00:00:00Z" }},
                "status": {{
                    "indicator": "{indicator}",
                    "description": "Service Status"
                }}
            }}"#
        )
        .into_bytes()
    }

    #[test]
    fn parses_operational_status() {
        let status = parse_statuspage_status(&status_response("none")).expect("valid status");
        assert_eq!(status.level, ProviderStatusLevel::Operational);
        assert_eq!(status.updated_at.as_deref(), Some("2026-07-14T00:00:00Z"));
    }

    #[test]
    fn maps_minor_to_degraded() {
        let status = parse_statuspage_status(&status_response("minor")).expect("valid status");
        assert_eq!(status.level, ProviderStatusLevel::Degraded);
    }

    #[test]
    fn maps_major_and_critical_to_outage() {
        for indicator in ["major", "critical"] {
            let status =
                parse_statuspage_status(&status_response(indicator)).expect("valid status");
            assert_eq!(status.level, ProviderStatusLevel::Outage);
        }
    }

    #[test]
    fn rejects_unknown_indicator_instead_of_guessing() {
        let error = parse_statuspage_status(&status_response("mystery"))
            .expect_err("unknown indicators must not be treated as healthy or unhealthy");
        assert!(error.contains("unsupported Statuspage indicator"));
    }

    #[test]
    fn rejects_malformed_responses() {
        let error = parse_statuspage_status(br#"{"status":{}}"#)
            .expect_err("malformed response must fail loudly");
        assert!(error.contains("invalid Statuspage response"));
    }

    #[test]
    fn rejects_empty_descriptions() {
        let body = br#"{
            "status": {
                "indicator": "none",
                "description": "   "
            }
        }"#;
        let error = parse_statuspage_status(body)
            .expect_err("empty descriptions must not be treated as healthy");
        assert!(error.contains("empty description"));
    }

    #[test]
    #[serial]
    fn status_fetch_inherits_environment_proxy_without_manual_proxy() {
        assert!(
            crate::config::get_resolved_proxy().is_none(),
            "proxy inheritance test requires no manual OpenUsageCN proxy"
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy listener");
        listener
            .set_nonblocking(true)
            .expect("set proxy listener nonblocking");
        let proxy_url = format!("http://{}", listener.local_addr().expect("proxy address"));
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error)
                        if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept proxy request: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set proxy read timeout");
            let mut request = [0_u8; 4096];
            let bytes_read = stream.read(&mut request).expect("read proxy request");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                )
                .expect("write proxy response");
            String::from_utf8_lossy(&request[..bytes_read]).into_owned()
        });

        let _env = [
            EnvVarGuard::set("HTTP_PROXY", &proxy_url),
            EnvVarGuard::set("http_proxy", &proxy_url),
            EnvVarGuard::set("ALL_PROXY", &proxy_url),
            EnvVarGuard::set("all_proxy", &proxy_url),
            EnvVarGuard::set("NO_PROXY", ""),
            EnvVarGuard::set("no_proxy", ""),
        ];

        let client = build_status_client(false).expect("status client");
        let response = client
            .get("http://example.invalid/provider-status-proxy-regression")
            .send()
            .expect("proxied status request");

        let proxy_request = server.join().expect("proxy server");

        assert_eq!(response.status(), 200);
        assert!(
            proxy_request.starts_with(
                "GET http://example.invalid/provider-status-proxy-regression HTTP/1.1"
            ),
            "unexpected proxy request: {proxy_request}"
        );
    }
}
