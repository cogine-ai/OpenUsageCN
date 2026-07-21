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

fn fetch_statuspage_status(api_url: &str) -> Result<ProviderStatus, String> {
    let mut client_builder = reqwest::blocking::Client::builder()
        .timeout(STATUS_REQUEST_TIMEOUT)
        .connect_timeout(STATUS_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .https_only(true)
        .user_agent("OpenUsageCN/provider-status")
        .no_proxy();
    if let Some(resolved) = crate::config::get_resolved_proxy() {
        client_builder = client_builder.proxy(resolved.proxy.clone());
    }
    let client = client_builder
        .build()
        .map_err(|error| format!("failed to build status client: {error}"))?;
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
}
