use reqwest::Proxy;
use serde::Deserialize;
use std::net::IpAddr;
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

/// Apply proxy policy for an outbound HTTP client.
///
/// Loopback targets always bypass proxies (manual and environment/system) so
/// CSRF-bearing local language-server calls cannot be observed or spoofed by
/// a shared HTTP_PROXY. Manual proxy wins for non-loopback URLs; otherwise
/// reqwest may discover environment/native proxies.
pub fn configure_http_client(
    builder: reqwest::blocking::ClientBuilder,
    target_url: &str,
) -> reqwest::blocking::ClientBuilder {
    if is_loopback_url(target_url) {
        log::debug!("[http] proxy bypassed for loopback address");
        return builder.no_proxy();
    }

    if let Some(resolved) = get_resolved_proxy() {
        log::debug!("[http] proxy active");
        builder.proxy(resolved.proxy.clone())
    } else {
        log::debug!(
            "[http] no manual proxy configured; automatic proxy discovery may apply"
        );
        builder
    }
}

/// True when the URL host is localhost or any IP loopback address.
pub fn is_loopback_url(target_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(target_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };

    let host = host.trim_start_matches('[').trim_end_matches(']');

    host.trim_end_matches('.').eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.to_canonical().is_loopback())
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
    fn loopback_urls_bypass_proxy() {
        assert!(is_loopback_url("http://localhost:6736/v1/limits"));
        assert!(is_loopback_url("http://localhost.:6736/v1/limits"));
        assert!(is_loopback_url("http://127.0.0.1:42001/GetUnleashData"));
        assert!(is_loopback_url("http://127.42.0.1/test"));
        assert!(is_loopback_url("http://[::1]:6736/v1/limits"));
        assert!(is_loopback_url(
            "http://[::ffff:127.0.0.1]:6736/v1/limits"
        ));
        assert!(!is_loopback_url("https://chatgpt.com/backend-api/wham/usage"));
        assert!(!is_loopback_url("not a url"));
    }
}
