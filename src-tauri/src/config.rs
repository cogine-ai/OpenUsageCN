use reqwest::Proxy;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Proxy configuration loaded from the platform-specific application config path.
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub url: String,
}

/// Top-level application config
#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub proxy: Option<ProxyConfig>,
}

/// Resolved proxy state — computed once at startup, used per-request.
/// This avoids re-parsing or re-validating on every HTTP call.
#[derive(Debug, Clone)]
pub struct ResolvedProxy {
    pub proxy: Proxy,
}

/// Global resolved proxy: Some(active) or None(disabled).
static RESOLVED_PROXY: OnceLock<Option<ResolvedProxy>> = OnceLock::new();
static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

#[cfg(target_os = "windows")]
pub fn initialize_path(path: PathBuf) {
    if CONFIG_PATH.set(path.clone()).is_err() && CONFIG_PATH.get() != Some(&path) {
        log::error!("proxy config path was initialized more than once");
    }
}

/// Returns the resolved proxy, or None if disabled/invalid/missing.
/// Loaded once from disk on first call; subsequent calls are zero-cost.
pub fn get_resolved_proxy() -> Option<&'static ResolvedProxy> {
    RESOLVED_PROXY
        .get_or_init(|| load_and_resolve_proxy())
        .as_ref()
}

/// Starts an HTTP client builder with the app's resolved manual proxy.
/// When no manual proxy is configured, reqwest keeps its automatic proxy behavior.
pub fn blocking_client_builder() -> reqwest::blocking::ClientBuilder {
    blocking_client_builder_with_proxy(get_resolved_proxy())
}

fn blocking_client_builder_with_proxy(
    resolved: Option<&ResolvedProxy>,
) -> reqwest::blocking::ClientBuilder {
    let builder = reqwest::blocking::Client::builder();
    match resolved {
        Some(resolved) => builder.proxy(resolved.proxy.clone()),
        None => builder,
    }
}

/// Config file path (initialized from the Tauri app path on Windows).
fn config_path() -> Option<PathBuf> {
    if let Some(path) = CONFIG_PATH.get() {
        return Some(path.clone());
    }

    #[cfg(target_os = "windows")]
    return dirs::data_local_dir()
        .map(|base| base.join("ai.cogine.openusagecn").join("config.json"));

    #[cfg(not(target_os = "windows"))]
    dirs::home_dir().map(|home| home.join(".openusagecn").join("config.json"))
}

/// Loads config from disk, resolves proxy, logs result.
fn load_and_resolve_proxy() -> Option<ResolvedProxy> {
    let Some(path) = config_path() else {
        log::debug!("[config] no home directory, proxy disabled");
        return None;
    };
    let config = match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<AppConfig>(&contents) {
            Ok(cfg) => cfg,
            Err(e) => {
                log::warn!(
                    "[config] failed to parse {}: {}, using defaults",
                    crate::plugin_engine::host_api::redact_log_message(&path.display().to_string()),
                    e
                );
                return None;
            }
        },
        Err(_) => {
            log::debug!(
                "[config] no config file at {}, using defaults",
                crate::plugin_engine::host_api::redact_log_message(&path.display().to_string())
            );
            return None;
        }
    };

    let Some(proxy_cfg) = config.proxy.as_ref().filter(|p| p.enabled) else {
        log::debug!("[config] proxy disabled");
        return None;
    };

    match Proxy::all(&proxy_cfg.url) {
        Ok(proxy) => {
            let redacted = redact_proxy_url(&proxy_cfg.url);
            log::debug!("[config] proxy enabled: {}", redacted);

            // Build no-proxy bypass for localhost
            let no_proxy = reqwest::NoProxy::from_string("localhost,127.0.0.1,::1");
            let proxy = proxy.no_proxy(no_proxy);

            Some(ResolvedProxy { proxy })
        }
        Err(e) => {
            log::warn!("[config] proxy disabled due to invalid URL: {}", e);
            None
        }
    }
}

/// Redacts user info from a proxy URL for safe logging.
pub fn redact_proxy_url(url: &str) -> String {
    // Simple redaction: look for ://user:pass@ pattern
    if let Some(at_pos) = url.find('@') {
        if let Some(scheme_end) = url.find("://") {
            let userinfo_start = scheme_end + 3;
            format!("{}***@{}", &url[..userinfo_start], &url[at_pos + 1..])
        } else {
            format!("***@{}", &url[at_pos + 1..])
        }
    } else {
        url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn redact_proxy_url_with_credentials() {
        let url = "http://user:pass@127.0.0.1:10808";
        let redacted = redact_proxy_url(url);
        assert_eq!(redacted, "http://***@127.0.0.1:10808");
        assert!(!redacted.contains("user"));
        assert!(!redacted.contains("pass"));
    }

    #[test]
    fn redact_proxy_url_without_credentials() {
        let url = "http://127.0.0.1:10808";
        let redacted = redact_proxy_url(url);
        assert_eq!(redacted, "http://127.0.0.1:10808");
    }

    #[test]
    fn proxy_disabled_when_enabled_false() {
        let config = AppConfig {
            proxy: Some(ProxyConfig {
                enabled: false,
                url: "http://127.0.0.1:10808".to_string(),
            }),
        };
        assert!(config.proxy.as_ref().filter(|p| p.enabled).is_none());
    }

    #[test]
    fn proxy_enabled_when_enabled_true() {
        let config = AppConfig {
            proxy: Some(ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:10808".to_string(),
            }),
        };
        assert!(config.proxy.as_ref().filter(|p| p.enabled).is_some());
    }

    #[test]
    fn manual_proxy_is_applied_to_blocking_clients() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy listener");
        listener
            .set_nonblocking(true)
            .expect("set proxy listener nonblocking");
        let proxy_url = format!("http://{}", listener.local_addr().expect("proxy address"));
        let resolved = ResolvedProxy {
            proxy: Proxy::all(&proxy_url).expect("manual proxy"),
        };
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
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .expect("write proxy response");
            String::from_utf8_lossy(&request[..bytes_read]).into_owned()
        });

        let client = blocking_client_builder_with_proxy(Some(&resolved))
            .timeout(Duration::from_secs(2))
            .build()
            .expect("proxied client");
        let response = client
            .get("http://manual-proxy.invalid/proxy-regression")
            .send()
            .expect("proxied request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);

        let proxy_request = server.join().expect("proxy server");
        assert!(
            proxy_request.starts_with("GET http://manual-proxy.invalid/proxy-regression HTTP/1.1"),
            "unexpected proxy request: {proxy_request}"
        );
    }
}
