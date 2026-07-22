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

#[derive(Debug, Clone)]
enum ProxyMode {
    Manual(Proxy),
    #[cfg(target_os = "windows")]
    System,
    Direct,
}

static PROXY_MODE: OnceLock<ProxyMode> = OnceLock::new();
static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

#[cfg(target_os = "windows")]
pub fn initialize_path(path: PathBuf) {
    if CONFIG_PATH.set(path.clone()).is_err() && CONFIG_PATH.get() != Some(&path) {
        log::error!("proxy config path was initialized more than once");
    }
}

pub fn initialize_proxy() {
    let _ = proxy_mode();
}

pub fn configure_http_client(
    builder: reqwest::blocking::ClientBuilder,
    target_url: &str,
) -> reqwest::blocking::ClientBuilder {
    if is_loopback_url(target_url) {
        log::debug!("[http] proxy bypassed for loopback address");
        return builder.no_proxy();
    }

    match proxy_mode() {
        ProxyMode::Manual(proxy) => {
            log::debug!("[http] manual proxy active");
            builder.no_proxy().proxy(proxy.clone())
        }
        #[cfg(target_os = "windows")]
        ProxyMode::System => {
            log::debug!("[http] Windows system proxy discovery active");
            builder
        }
        ProxyMode::Direct => {
            log::debug!("[http] proxy not used");
            builder.no_proxy()
        }
    }
}

fn proxy_mode() -> &'static ProxyMode {
    PROXY_MODE.get_or_init(load_and_resolve_proxy)
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

fn load_and_resolve_proxy() -> ProxyMode {
    let Some(path) = config_path() else {
        log::debug!("[config] no manual proxy config path, using platform default");
        return default_proxy_mode();
    };
    let config = match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<AppConfig>(&contents) {
            Ok(cfg) => cfg,
            Err(e) => {
                log::error!(
                    "[config] failed to parse {}: {}, proxy disabled",
                    crate::plugin_engine::host_api::redact_log_message(&path.display().to_string()),
                    e
                );
                return ProxyMode::Direct;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            log::debug!("[config] no manual proxy config found");
            return default_proxy_mode();
        }
        Err(error) => {
            log::error!(
                "[config] failed to read {}: {}, proxy disabled",
                crate::plugin_engine::host_api::redact_log_message(&path.display().to_string()),
                error
            );
            return ProxyMode::Direct;
        }
    };

    resolve_config(config)
}

fn resolve_config(config: AppConfig) -> ProxyMode {
    let Some(proxy_cfg) = config.proxy else {
        log::debug!("[config] no manual proxy configured");
        return default_proxy_mode();
    };

    if !proxy_cfg.enabled {
        log::debug!("[config] proxy disabled");
        return ProxyMode::Direct;
    }

    match Proxy::all(&proxy_cfg.url) {
        Ok(proxy) => {
            let redacted = redact_proxy_url(&proxy_cfg.url);
            log::debug!("[config] proxy enabled: {}", redacted);

            // Keep the documented loopback bypass for manual proxy requests.
            let no_proxy = reqwest::NoProxy::from_string("localhost,127.0.0.1,::1");
            let proxy = proxy.no_proxy(no_proxy);

            ProxyMode::Manual(proxy)
        }
        Err(e) => {
            log::error!("[config] proxy disabled due to invalid URL: {}", e);
            ProxyMode::Direct
        }
    }
}

fn default_proxy_mode() -> ProxyMode {
    #[cfg(target_os = "windows")]
    {
        log::debug!("[config] Windows system proxy discovery enabled");
        ProxyMode::System
    }

    #[cfg(not(target_os = "windows"))]
    {
        ProxyMode::Direct
    }
}

fn is_loopback_url(target_url: &str) -> bool {
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
        assert!(matches!(resolve_config(config), ProxyMode::Direct));
    }

    #[test]
    fn proxy_enabled_when_enabled_true() {
        let config = AppConfig {
            proxy: Some(ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:10808".to_string(),
            }),
        };
        assert!(matches!(resolve_config(config), ProxyMode::Manual(_)));
    }

    #[test]
    fn missing_manual_proxy_uses_platform_default() {
        let mode = resolve_config(AppConfig { proxy: None });

        #[cfg(target_os = "windows")]
        assert!(matches!(mode, ProxyMode::System));
        #[cfg(not(target_os = "windows"))]
        assert!(matches!(mode, ProxyMode::Direct));
    }

    #[test]
    fn invalid_manual_proxy_disables_proxying() {
        let config = AppConfig {
            proxy: Some(ProxyConfig {
                enabled: true,
                url: "not a proxy URL".to_string(),
            }),
        };
        assert!(matches!(resolve_config(config), ProxyMode::Direct));
    }

    #[test]
    fn loopback_urls_bypass_proxy() {
        assert!(is_loopback_url("http://localhost:6736/v1/limits"));
        assert!(is_loopback_url("http://localhost.:6736/v1/limits"));
        assert!(is_loopback_url("http://127.0.0.1:6736/v1/limits"));
        assert!(is_loopback_url("http://127.42.0.1/test"));
        assert!(is_loopback_url("http://[::1]:6736/v1/limits"));
        assert!(is_loopback_url(
            "http://[::ffff:127.0.0.1]:6736/v1/limits"
        ));
        assert!(!is_loopback_url("https://chatgpt.com/backend-api/wham/usage"));
    }
}
