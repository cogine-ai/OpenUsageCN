use super::{
    AccountsView, Operation, Primary, VerificationView,
    model::{Record, key_hint},
    store,
};
use crate::{AppState, plugin_engine::manifest::LoadedPlugin};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Emitter;

fn context(state: &Mutex<AppState>) -> Result<(LoadedPlugin, PathBuf, String), String> {
    let state = state.lock().map_err(|_| "无法读取 Ollama 设置，请重试。")?;
    let plugin = state
        .plugins
        .iter()
        .find(|p| p.manifest.id == "ollama")
        .cloned()
        .ok_or("未找到 Ollama Cloud。")?;
    Ok((
        plugin,
        state.app_data_dir.clone(),
        state.app_version.clone(),
    ))
}

fn view() -> Result<AccountsView, String> {
    let _guard = store::lock()?;
    Ok(store::read()?.view())
}

fn emit(app: &tauri::AppHandle, revision: u64) {
    if let Err(error) = app.emit(
        "ollama-accounts-changed",
        serde_json::json!({"revision": revision}),
    ) {
        log::error!("Ollama account change event failed: {error}");
    }
}

#[tauri::command]
pub(crate) async fn check_ollama_legacy_connection(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<crate::plugin_engine::runtime::PluginOutput, String> {
    let (plugin, dir, version) = context(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let stamp = super::legacy_configuration_generation(&plugin);
        let output = crate::plugin_engine::runtime::run_probe(&plugin, &dir, &version);
        if stamp != super::legacy_configuration_generation(&plugin) { return Err(store::changed()); }
        if output.lines.iter().any(|line| matches!(line, crate::plugin_engine::runtime::MetricLine::Badge { label, .. } if label == "Error")) {
            log::warn!("Ollama legacy connection check failed");
            return Err("原连接检查失败，请检查所选来源的凭据和网络；其他账号未改变。".into());
        }
        Ok(output)
    }).await.map_err(|_| "原连接检查意外停止，请重试。".to_string())?
}

#[tauri::command]
pub(crate) async fn get_ollama_accounts() -> Result<AccountsView, String> {
    tauri::async_runtime::spawn_blocking(view)
        .await
        .map_err(|_| "无法加载 Ollama 账号，请重试。".to_string())?
}

#[tauri::command]
pub(crate) async fn verify_ollama_key(
    api_key: String,
    connection_id: Option<String>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<VerificationView, String> {
    let key = store::validate_key(&api_key)?;
    let (plugin, dir, version) = context(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        verify(&plugin, &dir, &version, key, connection_id)
    })
    .await
    .map_err(|_| "Key 验证意外停止，请重试。".to_string())?
}

pub(super) fn verify(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    api_key: String,
    connection_id: Option<String>,
) -> Result<VerificationView, String> {
    let target = {
        let _guard = store::lock()?;
        let stored = store::read()?;
        match connection_id {
            Some(id) => Some((
                id.clone(),
                stored
                    .connections
                    .iter()
                    .find(|r| r.connection_id == id)
                    .ok_or_else(store::changed)?
                    .revision,
            )),
            None => None,
        }
    };
    let probe = super::runtime::probe(plugin, dir, version, &api_key).map_err(|e| e.message)?;
    let mut guard = store::lock()?;
    let stored = store::read()?;
    let old = match &target {
        Some((id, revision)) => Some(
            stored
                .connections
                .iter()
                .find(|r| &r.connection_id == id && &r.revision == revision)
                .ok_or_else(store::changed)?,
        ),
        None => None,
    };
    let verification_id = uuid::Uuid::new_v4().to_string();
    let result = VerificationView {
        verification_id: verification_id.clone(),
        identity: probe.identity.display.clone(),
        key_hint: key_hint(&api_key),
        different_account: old
            .is_some_and(|r| r.identity_fingerprint != probe.identity.fingerprint),
        same_account: stored.connections.iter().any(|r| {
            r.identity_fingerprint == probe.identity.fingerprint
                && old.is_none_or(|old| old.connection_id != r.connection_id)
        }),
        plan: probe.plan.clone(),
    };
    guard
        .pending
        .retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
    if guard.pending.len() >= 20 {
        return Err("待确认的 Key 过多，请稍后再试。".into());
    }
    guard.pending.insert(
        verification_id,
        store::Pending {
            api_key,
            target,
            probe,
            created: Instant::now(),
        },
    );
    Ok(result)
}

#[tauri::command]
pub(crate) async fn save_ollama_key(
    verification_id: String,
    label: String,
    as_new: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<AccountsView, String> {
    let label = store::validate_label(&label)?;
    let (plugin, _, _) = context(&state)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        save(&plugin, &verification_id, label, as_new.unwrap_or(false))
    })
    .await
    .map_err(|_| "无法保存连接，请重新验证 Key。".to_string())??;
    emit(&app, result.revision);
    Ok(result)
}

pub(super) fn save(
    plugin: &LoadedPlugin,
    verification_id: &str,
    label: String,
    as_new: bool,
) -> Result<AccountsView, String> {
    let mut guard = store::lock()?;
    let pending = guard
        .pending
        .remove(verification_id)
        .ok_or("验证结果已失效，请重新验证 Key。")?;
    if pending.created.elapsed() >= Duration::from_secs(300) {
        return Err("验证结果已过期，请重新验证 Key。".into());
    }
    let mut stored = store::read()?;
    let target = match &pending.target {
        Some((id, revision)) => Some(
            stored
                .connections
                .iter()
                .position(|r| &r.connection_id == id && &r.revision == revision)
                .ok_or_else(store::changed)?,
        ),
        None => None,
    };
    if target.is_some_and(|i| {
        stored.connections[i].identity_fingerprint != pending.probe.identity.fingerprint
    }) && !as_new
    {
        return Err("此 Key 属于另一个账号，请明确选择作为新账号添加。原连接未被替换。".into());
    }
    let replacing = target.filter(|_| !as_new);
    let id = replacing
        .map(|i| stored.connections[i].connection_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let revision = replacing
        .map(|i| {
            stored.connections[i]
                .revision
                .checked_add(1)
                .ok_or_else(store::changed)
        })
        .transpose()?
        .unwrap_or(1);
    let record = Record {
        connection_id: id.clone(),
        label,
        identity: pending.probe.identity.display,
        identity_fingerprint: pending.probe.identity.fingerprint,
        api_key: pending.api_key,
        revision,
        snapshot: Some(super::output(
            plugin,
            pending.probe.plan,
            pending.probe.lines,
        )),
        last_updated_at: Some(super::now()),
        error: None,
    };
    if let Some(index) = replacing {
        stored.connections[index] = record;
    } else {
        if stored.connections.len() >= 100 {
            return Err("最多保存 100 个连接，请先移除不用的连接。".into());
        }
        stored.connections.push(record);
    }
    let projection_changed = replacing.is_some()
        && matches!(&stored.primary, Primary::Connection { connection_id } if connection_id == &id);
    store::write(&mut stored, projection_changed)?;
    Ok(stored.view())
}

#[tauri::command]
pub(crate) async fn perform_ollama_account_operation(
    operation: Operation,
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<AccountsView, String> {
    let (plugin, dir, version) = context(&state)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || perform(&plugin, &dir, &version, operation))
            .await
            .map_err(|_| "账号操作意外停止，请重试。".to_string())?;
    // A bounded refresh-all can stop after publishing successful earlier connections.
    // Announce the persisted revision even when the operation reports a later failure.
    if let Ok(latest) = view() {
        emit(&app, latest.revision);
    }
    result
}

pub(super) fn perform(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    operation: Operation,
) -> Result<AccountsView, String> {
    if let Operation::Refresh { connection_id } = operation {
        let ids = {
            let _guard = store::lock()?;
            let stored = store::read()?;
            match connection_id {
                Some(id) => vec![id],
                None => stored
                    .connections
                    .into_iter()
                    .map(|r| r.connection_id)
                    .collect(),
            }
        };
        let started = Instant::now();
        for id in ids {
            if started.elapsed() >= Duration::from_secs(60) {
                log::warn!("Ollama refresh-all time budget reached");
                return Err("批量刷新已超时，未完成的连接保留原数据，请分别刷新。".into());
            }
            super::refresh(plugin, dir, version, &id, started + Duration::from_secs(60))?;
        }
        return view();
    }
    let _guard = store::lock()?;
    let mut stored = store::read()?;
    let mut projection_changed = false;
    match operation {
        Operation::SelectPrimary { connection_id } => {
            if !stored.connections.iter().any(|r| {
                r.connection_id == connection_id
                    && !r.error.as_ref().is_some_and(|e| {
                        matches!(e.code.as_str(), "authExpired" | "identityChanged")
                    })
            }) {
                return Err("请先验证此连接，再设为主账号。".into());
            }
            stored.primary = Primary::Connection { connection_id };
            projection_changed = true;
        }
        Operation::UseLegacy => {
            stored.primary = Primary::Legacy;
            projection_changed = true;
        }
        Operation::Rename {
            connection_id,
            label,
        } => {
            stored
                .connections
                .iter_mut()
                .find(|r| r.connection_id == connection_id)
                .ok_or_else(store::changed)?
                .label = store::validate_label(&label)?;
        }
        Operation::Remove { connection_id } => {
            let index = stored
                .connections
                .iter()
                .position(|r| r.connection_id == connection_id)
                .ok_or_else(store::changed)?;
            stored.connections.remove(index);
            if matches!(&stored.primary, Primary::Connection { connection_id: id } if id == &connection_id)
            {
                stored.primary = Primary::None;
                projection_changed = true;
            }
        }
        Operation::Refresh { .. } => unreachable!(),
    }
    store::write(&mut stored, projection_changed)?;
    Ok(stored.view())
}
