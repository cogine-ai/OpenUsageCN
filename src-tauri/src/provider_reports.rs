use crate::AppState;
use crate::plugin_engine::{host_api, runtime};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct ProviderReportsState {
    current: Mutex<HashMap<String, ReportRequest>>,
}

struct ReportRequest {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl ProviderReportsState {
    fn begin(&self, provider_id: &str, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Report state is unavailable.")?;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(previous) = current.insert(
            provider_id.to_string(),
            ReportRequest {
                request_id: request_id.to_string(),
                cancelled: Arc::clone(&cancelled),
            },
        ) {
            previous.cancelled.store(true, Ordering::Release);
        }
        Ok(cancelled)
    }

    fn cancel(&self, provider_id: &str, request_id: &str) -> Result<(), String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Report state is unavailable.")?;
        if current
            .get(provider_id)
            .is_some_and(|job| job.request_id == request_id)
        {
            if let Some(job) = current.remove(provider_id) {
                job.cancelled.store(true, Ordering::Release);
            }
        }
        Ok(())
    }
}

fn configuration_fingerprint(values: HashMap<String, serde_json::Value>) -> Result<String, String> {
    // HashMap iteration order is unstable; only the exact resolved values determine this digest.
    let sorted: BTreeMap<_, _> = values.into_iter().collect();
    let mut bytes =
        serde_json::to_vec(&sorted).map_err(|_| "Could not verify report settings.".to_string())?;
    let digest = crate::safe_file::sha256_hex(&bytes);
    bytes.fill(0);
    Ok(digest)
}

fn with_configuration_guard<T>(
    expected: &str,
    read_current: impl Fn() -> HashMap<String, serde_json::Value>,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let changed = || "Provider connection changed. Reload server reports.".to_string();
    // A queued request must not run after its settings have already changed.
    if configuration_fingerprint(read_current())? != expected {
        return Err(changed());
    }
    let result = work();
    // The JS host uses a fixed configuration snapshot. Re-read the live host store here.
    if configuration_fingerprint(read_current())? != expected {
        return Err(changed());
    }
    result
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportCoverage {
    pub from_date: String,
    pub to_date: String,
    pub time_zone: String,
    #[serde(default)]
    pub reported_dates: Vec<String>,
    #[serde(default)]
    pub missing_dates: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReportStatus {
    Ready,
    Partial,
    NotSupported,
    PermissionDenied,
    RateLimited,
    AuthExpired,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportSection {
    pub id: String,
    pub label: String,
    pub status: ReportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<ReportCoverage>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportsOutput {
    pub scope_key: String,
    pub lines: Vec<runtime::MetricLine>,
    pub reports: Vec<ReportSection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderReportsSnapshot {
    pub request_id: String,
    pub provider_id: String,
    pub scope_key: String,
    pub fetched_at: String,
    pub lines: Vec<runtime::MetricLine>,
    pub reports: Vec<ReportSection>,
}

#[tauri::command]
pub(crate) async fn refresh_provider_reports(
    provider_id: String,
    request_id: String,
    state: tauri::State<'_, Mutex<AppState>>,
    reports: tauri::State<'_, ProviderReportsState>,
) -> Result<ProviderReportsSnapshot, String> {
    if !matches!(provider_id.as_str(), "codex" | "ollama" | "openrouter") {
        return Err("Server reports are unavailable for this provider.".to_string());
    }
    // Start the overall budget before setup or waiting for a blocking worker.
    let deadline = Instant::now() + Duration::from_secs(60);
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Report request ID is invalid.".to_string());
    }
    let cancelled = reports.begin(&provider_id, &request_id)?;
    let (plugin, app_data_dir, app_version) = {
        let locked = state
            .lock()
            .map_err(|_| "Could not load report settings.")?;
        let plugin = locked
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == provider_id)
            .cloned()
            .ok_or("Provider was not found.")?;
        (
            plugin,
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };
    let config_fields = plugin
        .manifest
        .config
        .as_ref()
        .map(|config| config.fields.clone())
        .unwrap_or_default();
    let expected_config = configuration_fingerprint(crate::provider_config::resolved_values(
        &provider_id,
        &config_fields,
    ))?;
    let worker_cancelled = Arc::clone(&cancelled);
    let output = tauri::async_runtime::spawn_blocking(move || {
        with_configuration_guard(
            &expected_config,
            || crate::provider_config::resolved_values(&plugin.manifest.id, &config_fields),
            || {
                runtime::run_reports(
                    &plugin,
                    &app_data_dir,
                    &app_version,
                    deadline,
                    worker_cancelled,
                )
            },
        )
    })
    .await
    .map_err(|_| {
        log::error!("server reports worker stopped: provider={}", provider_id);
        "Server reports stopped unexpectedly. Try again.".to_string()
    })?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Server reports request was replaced or cancelled.".to_string());
    }
    if Instant::now() >= deadline {
        log::warn!("server reports timed out: provider={}", provider_id);
        return Err("Server reports timed out. Try again.".to_string());
    }
    let output = output.map_err(|message| {
        // Plugin exceptions can contain upstream data. Never return or log them unredacted.
        let safe = host_api::redact_log_message(&message);
        log::warn!(
            "server reports failed: provider={}, reason={}",
            provider_id,
            safe
        );
        safe
    })?;
    for report in &output.reports {
        if matches!(
            report.status,
            ReportStatus::PermissionDenied
                | ReportStatus::RateLimited
                | ReportStatus::AuthExpired
                | ReportStatus::Error
        ) {
            log::warn!(
                "server report unavailable: provider={}, status={:?}",
                provider_id,
                report.status
            );
        }
    }
    Ok(ProviderReportsSnapshot {
        request_id,
        provider_id,
        scope_key: output.scope_key,
        fetched_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| "Report update time is unavailable.")?,
        lines: output.lines,
        reports: output.reports,
    })
}

#[tauri::command]
pub(crate) fn cancel_provider_reports(
    provider_id: String,
    request_id: String,
    reports: tauri::State<'_, ProviderReportsState>,
) -> Result<(), String> {
    reports.cancel(&provider_id, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_or_cancelling_a_request_invalidates_only_its_provider() {
        let state = ProviderReportsState::default();
        let old = state.begin("codex", "old").unwrap();
        let other = state.begin("ollama", "other").unwrap();
        let next = state.begin("codex", "next").unwrap();
        assert!(old.load(Ordering::Acquire));
        assert!(!other.load(Ordering::Acquire));
        assert!(!next.load(Ordering::Acquire));
        state.cancel("codex", "old").unwrap();
        assert!(
            !next.load(Ordering::Acquire),
            "Old component cleanup must not cancel the new request"
        );
        state.cancel("codex", "next").unwrap();
        assert!(next.load(Ordering::Acquire));
        assert!(!other.load(Ordering::Acquire));
    }

    fn settings(source: &str, key: &str) -> HashMap<String, serde_json::Value> {
        HashMap::from([
            ("source".into(), serde_json::json!(source)),
            ("apiKey".into(), serde_json::json!(key)),
            (
                "apiUrl".into(),
                serde_json::json!("https://reports.example.invalid"),
            ),
        ])
    }

    #[test]
    fn configuration_digest_is_order_independent_but_binds_exact_source_and_secret() {
        let original = settings("apiKey", "synthetic-key-a");
        let mut reversed = HashMap::new();
        for key in ["apiUrl", "apiKey", "source"] {
            reversed.insert(key.to_string(), original[key].clone());
        }
        let expected = configuration_fingerprint(original).unwrap();
        assert_eq!(configuration_fingerprint(reversed).unwrap(), expected);
        assert_ne!(
            configuration_fingerprint(settings("apiKey", "synthetic-key-b")).unwrap(),
            expected
        );
        assert_ne!(
            configuration_fingerprint(settings("cookie", "synthetic-key-a")).unwrap(),
            expected
        );
        assert_ne!(
            configuration_fingerprint(settings("apiKey", "synthetic-key-a ")).unwrap(),
            expected
        );
    }

    #[test]
    fn a_configuration_changed_while_queued_never_starts_report_work() {
        let expected = configuration_fingerprint(settings("apiKey", "synthetic-key-a")).unwrap();
        let called = AtomicBool::new(false);
        let result = with_configuration_guard(
            &expected,
            || settings("apiKey", "synthetic-key-b"),
            || {
                called.store(true, Ordering::Release);
                Ok("stale report")
            },
        );
        assert!(!called.load(Ordering::Acquire));
        assert!(result.unwrap_err().contains("connection changed"));
    }

    #[test]
    fn a_successful_report_from_old_settings_is_discarded_after_a_concurrent_save() {
        let current = Arc::new(Mutex::new(settings("apiKey", "synthetic-key-a")));
        let expected = configuration_fingerprint(current.lock().unwrap().clone()).unwrap();
        let worker_settings = Arc::clone(&current);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_configuration_guard(
                &expected,
                || worker_settings.lock().unwrap().clone(),
                || {
                    started_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                    Ok("successful response captured with the old key")
                },
            )
        });
        started_rx.recv().unwrap();
        *current.lock().unwrap() = settings("cookie", "synthetic-key-b");
        resume_tx.send(()).unwrap();
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.contains("connection changed"));
        assert!(!error.contains("synthetic-key"));
    }

    #[test]
    fn unchanged_host_settings_preserve_partial_report_results() {
        let current = settings("apiKey", "synthetic-key-a");
        let expected = configuration_fingerprint(current.clone()).unwrap();
        let result = with_configuration_guard(
            &expected,
            || current.clone(),
            || Ok(("counts-ready", "credits-denied")),
        );
        assert_eq!(result.unwrap(), ("counts-ready", "credits-denied"));
    }
}
