use crate::plugin_engine::{host_api, runtime};
use crate::{AppState, provider_accounts};
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[cfg(test)]
#[path = "local_history_tests.rs"]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalHistorySnapshot {
    provider_id: String,
    account_id: Option<String>,
    fetched_at: String,
    lines: Vec<runtime::MetricLine>,
}

#[tauri::command]
pub(crate) async fn refresh_local_history(
    provider_id: String,
    account_id: Option<String>,
    state: tauri::State<'_, Mutex<AppState>>,
    accounts: tauri::State<'_, Arc<provider_accounts::ProviderAccounts>>,
) -> Result<LocalHistorySnapshot, String> {
    if cfg!(target_os = "windows") {
        return Err("Windows 暂不支持本地用量历史。".to_string());
    }
    match (provider_id.as_str(), account_id.as_deref()) {
        ("codex", None) | ("claude", Some(_)) => {}
        _ => return Err("此服务商连接不支持本地用量历史。".to_string()),
    }
    let (plugin, app_data_dir, app_version) = {
        let locked = state
            .lock()
            .map_err(|_| "无法加载本地用量，请重试。".to_string())?;
        let plugin = locked
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == provider_id)
            .cloned()
            .ok_or_else(|| "未找到此服务商插件。".to_string())?;
        (
            plugin,
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };
    let accounts = Arc::clone(accounts.inner());
    let requested_account = account_id.clone();
    let result = tokio::task::spawn_blocking(move || match requested_account {
        Some(account_id) => accounts.run_local_history(&plugin.manifest.id, &account_id),
        None => Ok(runtime::run_local_history(
            &plugin,
            &app_data_dir,
            &app_version,
            None,
        )),
    })
    .await
    .map_err(|_| {
        log::error!("local history worker stopped: provider={}", provider_id);
        "本地用量读取意外停止，请重试。".to_string()
    })?;
    local_history_snapshot(provider_id, account_id, result)
}

fn local_history_snapshot(
    provider_id: String,
    account_id: Option<String>,
    result: Result<runtime::PluginOutput, String>,
) -> Result<LocalHistorySnapshot, String> {
    let output = result
        .and_then(|output| match runtime::probe_error_message(&output) {
            Some(message) => Err(message.to_string()),
            None if output.lines.iter().any(|line| {
                !matches!(
                    line,
                    runtime::MetricLine::Text { .. } | runtime::MetricLine::BarChart { .. }
                )
            }) =>
            {
                Err("本地用量返回了不支持的数据，请更新插件后重试。".to_string())
            }
            None => Ok(output),
        })
        .map_err(|message| {
            let redacted = host_api::redact_log_message(&message);
            log::warn!(
                "local history failed: provider={}, reason={}",
                provider_id,
                redacted
            );
            if message.starts_with("probe timed out") {
                "本地用量读取超时，请稍后重试。".to_string()
            } else {
                redacted
            }
        })?;
    let fetched_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| "本地用量更新时间不可用。".to_string())?;
    Ok(LocalHistorySnapshot {
        provider_id,
        account_id,
        fetched_at,
        lines: output.lines,
    })
}
