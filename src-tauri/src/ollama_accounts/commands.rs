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

fn view(plugin: &LoadedPlugin) -> Result<AccountsView, String> {
    super::legacy::synchronize(plugin, Instant::now() + Duration::from_secs(10))?;
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
    app: tauri::AppHandle,
) -> Result<crate::plugin_engine::runtime::PluginOutput, String> {
    let (plugin, dir, version) = context(&state)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        super::legacy::refresh(
            &plugin,
            &dir,
            &version,
            Instant::now() + Duration::from_secs(30),
        )
    })
    .await
    .map_err(|_| "原连接检查意外停止，请重试。".to_string())?;
    emit(&app, 0);
    result.and_then(|output| {
        if crate::plugin_engine::runtime::probe_error_message(&output).is_some() {
            Err("原连接检查失败，请检查所选来源的凭据和网络；其他账号未改变。".into())
        } else {
            Ok(output)
        }
    })
}

#[tauri::command]
pub(crate) async fn get_ollama_accounts(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<AccountsView, String> {
    let (plugin, _, _) = context(&state)?;
    tauri::async_runtime::spawn_blocking(move || view(&plugin))
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
    let event_app = app.clone();
    let deadline = operation_deadline(&operation);
    let (result, revision) = tauri::async_runtime::spawn_blocking(move || {
        let result = perform_before(&plugin, &dir, &version, operation, deadline, &|| {
            emit(&event_app, 0)
        });
        // Do not resolve credentials or open a new time budget just to announce partial success.
        let revision = result
            .as_ref()
            .ok()
            .map(|view| view.revision)
            .or_else(|| masked_view(deadline).ok().map(|view| view.revision));
        (result, revision)
    })
    .await
    .map_err(|_| {
        log::error!("Ollama account operation worker panicked");
        "账号操作意外停止，请重试。".to_string()
    })?;
    // A bounded refresh-all can stop after publishing successful earlier connections.
    // Announce the persisted revision even when the operation reports a later failure.
    if let Some(revision) = revision {
        emit(&app, revision);
    }
    result
}

#[cfg(test)]
pub(super) fn perform(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    operation: Operation,
) -> Result<AccountsView, String> {
    let deadline = operation_deadline(&operation);
    perform_before(plugin, dir, version, operation, deadline, &|| {})
}

fn operation_deadline(operation: &Operation) -> Instant {
    Instant::now()
        + Duration::from_secs(
            if matches!(
                operation,
                Operation::Refresh {
                    connection_id: None
                }
            ) {
                60
            } else {
                30
            },
        )
}

fn masked_view(deadline: Instant) -> Result<AccountsView, String> {
    let _guard = store::lock_until(deadline)?;
    Ok(store::read()?.view())
}

pub(super) fn perform_before(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    operation: Operation,
    deadline: Instant,
    changed: &(impl Fn() + Sync),
) -> Result<AccountsView, String> {
    if let Operation::RefreshLegacy = operation {
        super::legacy::refresh(plugin, dir, version, deadline)?;
        return masked_view(deadline);
    }
    if let Operation::Refresh { connection_id } = operation {
        if connection_id.is_none() {
            super::legacy::synchronize(plugin, deadline)?;
            let stored = {
                let _guard = store::lock_until(deadline)?;
                store::read()?
            };
            super::batch::refresh_all(plugin, dir, version, &stored, deadline, changed)?;
            return masked_view(deadline);
        }
        super::refresh(plugin, dir, version, &connection_id.unwrap(), deadline)?;
        return masked_view(deadline);
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
        Operation::Refresh { .. } | Operation::RefreshLegacy => unreachable!(),
    }
    store::write(&mut stored, projection_changed)?;
    Ok(stored.view())
}
