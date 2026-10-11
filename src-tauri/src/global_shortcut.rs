use serde::Serialize;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub shortcut: Option<String>,
    pub active: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct ShortcutState {
    saved: Option<String>,
    active: Option<String>,
    error: Option<String>,
    recording: Arc<AtomicBool>,
    active_callback: Option<ShortcutCallback>,
    restart_required: bool,
}

#[derive(Clone)]
struct ShortcutCallback {
    active: Arc<AtomicBool>,
    recording: Arc<AtomicBool>,
}

impl ShortcutCallback {
    fn enabled(&self) -> bool {
        self.active.load(Ordering::Acquire) && !self.recording.load(Ordering::Acquire)
    }
}

impl ShortcutState {
    fn status(&self) -> ShortcutStatus {
        ShortcutStatus {
            shortcut: self.saved.clone(),
            active: self.saved.is_some() && self.saved == self.active,
            error: self.error.clone(),
        }
    }

    fn candidate_callback(&self) -> ShortcutCallback {
        ShortcutCallback {
            active: Arc::new(AtomicBool::new(false)),
            recording: self.recording.clone(),
        }
    }

    fn recovery_error(&mut self, unregister_failed: bool) -> String {
        self.restart_required |= unregister_failed;
        let message = if self.restart_required {
            "快捷键未能完全恢复，请重启应用后重新设置。"
        } else {
            "快捷键保存状态无法确认，请重新设置。"
        }
        .to_string();
        self.error = Some(message.clone());
        message
    }
}

fn state() -> &'static Mutex<ShortcutState> {
    static STATE: OnceLock<Mutex<ShortcutState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ShortcutState::default()))
}

trait ShortcutBackend {
    fn register(&mut self, shortcut: &str, callback: ShortcutCallback) -> Result<(), String>;
    fn unregister(&mut self, shortcut: &str) -> Result<(), String>;
    fn save(&mut self, shortcut: Option<&str>) -> Result<(), String>;
}

struct RollbackFailure {
    message: String,
    unregister_failed: bool,
}

fn rollback(
    backend: &mut impl ShortcutBackend,
    previous: Option<&str>,
    candidate: Option<&str>,
) -> Result<(), RollbackFailure> {
    let mut errors = Vec::new();
    let mut unregister_failed = false;
    if let Some(candidate) = candidate {
        if let Err(error) = backend.unregister(candidate) {
            unregister_failed = true;
            errors.push(error);
        }
    }
    if let Err(error) = backend.save(previous) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(RollbackFailure {
            message: errors.join("; "),
            unregister_failed,
        })
    }
}

fn apply(
    state: &mut ShortcutState,
    backend: &mut impl ShortcutBackend,
    candidate: Option<String>,
) -> Result<ShortcutStatus, String> {
    if state.restart_required {
        log::error!("Refusing shortcut update after a failed native unregister; restart required");
        return Err(state.recovery_error(true));
    }
    if state.saved == candidate && state.active == candidate && state.error.is_none() {
        return Ok(state.status());
    }
    let newly_registered = candidate
        .as_deref()
        .filter(|value| Some(*value) != state.active.as_deref());
    let candidate_callback = newly_registered.map(|_| state.candidate_callback());
    if let Some(value) = newly_registered {
        backend
            .register(value, candidate_callback.as_ref().unwrap().clone())
            .map_err(|error| {
                log::error!("Failed to register candidate shortcut: {error}");
                "此组合无法使用，请试另一个快捷键。".to_string()
            })?;
    }
    if let Err(error) = backend.save(candidate.as_deref()) {
        log::error!("Failed to persist candidate shortcut: {error}");
        if let Err(rollback_error) = rollback(backend, state.saved.as_deref(), newly_registered) {
            log::error!(
                "Failed to roll back shortcut persistence: {}",
                rollback_error.message
            );
            return Err(state.recovery_error(rollback_error.unregister_failed));
        }
        return Err("无法保存快捷键，请重试。".into());
    }
    if let Some(previous) = state
        .active
        .as_deref()
        .filter(|value| Some(*value) != candidate.as_deref())
    {
        if let Err(error) = backend.unregister(previous) {
            log::error!("Failed to unregister previous shortcut: {error}");
            if let Err(rollback_error) = rollback(backend, state.saved.as_deref(), newly_registered)
            {
                log::error!(
                    "Failed to roll back shortcut replacement: {}",
                    rollback_error.message
                );
            }
            // macOS removes its native handle before reporting unregister errors.
            // A retry can return Ok without releasing the still-held OS chord.
            if let Some(previous) = state.active_callback.take() {
                previous.active.store(false, Ordering::Release);
            }
            state.active = None;
            return Err(state.recovery_error(true));
        }
    }
    if state.active != candidate {
        if let Some(previous) = state.active_callback.take() {
            previous.active.store(false, Ordering::Release);
        }
        if let Some(callback) = candidate_callback {
            callback.active.store(true, Ordering::Release);
            state.active_callback = Some(callback);
        }
    }
    state.saved = candidate.clone();
    state.active = candidate;
    state.error = None;
    Ok(state.status())
}

fn initialize_state(
    state: &mut ShortcutState,
    backend: &mut impl ShortcutBackend,
    saved: Option<String>,
) {
    state.saved = saved.clone();
    state.active = None;
    state.active_callback = None;
    state.error = None;
    state.restart_required = false;
    if let Some(shortcut) = saved {
        let callback = state.candidate_callback();
        match backend.register(&shortcut, callback.clone()) {
            Ok(()) => {
                callback.active.store(true, Ordering::Release);
                state.active_callback = Some(callback);
                state.active = Some(shortcut);
            }
            Err(error) => {
                log::error!("Failed to register initial shortcut: {error}");
                state.error = Some("快捷键未生效，请重新设置。".into());
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct NativeBackend<'a>(&'a tauri::AppHandle);

#[cfg(target_os = "macos")]
impl ShortcutBackend for NativeBackend<'_> {
    fn register(&mut self, shortcut: &str, callback: ShortcutCallback) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as EventState};
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state != EventState::Pressed {
                    return;
                }
                // Registration and persistence hold the transaction mutex and
                // may need the main thread. The native callback must never lock it.
                if callback.enabled() {
                    crate::panel::toggle_panel(app);
                }
            })
            .map_err(|error| error.to_string())
    }
    fn unregister(&mut self, shortcut: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }
    fn save(&mut self, shortcut: Option<&str>) -> Result<(), String> {
        use tauri_plugin_store::StoreExt;
        let store = self
            .0
            .store("settings.json")
            .map_err(|error| error.to_string())?;
        store.set("globalShortcut", serde_json::json!(shortcut));
        store.save().map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
fn normalized_shortcut(value: &str) -> Result<String, String> {
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
    let shortcut: Shortcut = value.parse().map_err(|error| {
        log::error!("Failed to parse shortcut: {error}");
        "此组合无法使用，请试另一个快捷键。".to_string()
    })?;
    let mut parts = Vec::new();
    for (modifier, name) in [
        (Modifiers::SUPER, "Command"),
        (Modifiers::CONTROL, "Control"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
    ] {
        if shortcut.mods.contains(modifier) {
            parts.push(name.to_string());
        }
    }
    let key = shortcut.key.to_string();
    parts.push(
        key.strip_prefix("Key")
            .or_else(|| key.strip_prefix("Digit"))
            .unwrap_or(&key)
            .to_string(),
    );
    Ok(parts.join("+"))
}

#[cfg(target_os = "macos")]
fn initialize_saved_shortcut(
    current: &mut ShortcutState,
    backend: &mut impl ShortcutBackend,
    saved: Option<String>,
) {
    match saved
        .as_deref()
        .map(|value| normalized_shortcut(value.trim()))
        .transpose()
    {
        Ok(value) => initialize_state(current, backend, value),
        Err(error) => {
            log::error!("Failed to parse initial shortcut setting: {error}");
            current.saved = saved;
            current.active = None;
            current.error = Some("快捷键格式无效，尚未生效，请重新设置。".into());
        }
    }
}

#[cfg(target_os = "macos")]
pub fn initialize(app: &tauri::AppHandle) {
    use tauri_plugin_store::StoreExt;
    let mut current = match state().lock() {
        Ok(current) => current,
        Err(error) => {
            log::error!("Failed to initialize shortcut state: {error}");
            return;
        }
    };
    let saved = app
        .store("settings.json")
        .map_err(|error| error.to_string())
        .map(|store| {
            store
                .get("globalShortcut")
                .and_then(|value| value.as_str().map(str::to_string))
                .filter(|value| !value.trim().is_empty())
        });
    match saved {
        Ok(value) => initialize_saved_shortcut(&mut current, &mut NativeBackend(app), value),
        Err(error) => {
            log::error!("Failed to load initial shortcut settings: {error}");
            current.error = Some("无法读取快捷键设置，请重新设置。".into());
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn update_global_shortcut(
    app_handle: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<ShortcutStatus, String> {
    let candidate = shortcut
        .filter(|value| !value.trim().is_empty())
        .map(|value| normalized_shortcut(value.trim()))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = state().lock().map_err(|error| {
            log::error!("Failed to lock shortcut state: {error}");
            "无法更新快捷键，请重试。".to_string()
        })?;
        apply(&mut current, &mut NativeBackend(&app_handle), candidate)
    })
    .await
    .map_err(|error| {
        log::error!("Shortcut update task failed: {error}");
        "无法更新快捷键，请重试。".to_string()
    })?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn update_global_shortcut(
    _app_handle: tauri::AppHandle,
    _shortcut: Option<String>,
) -> Result<ShortcutStatus, String> {
    Err("此平台不支持全局快捷键。".into())
}

#[tauri::command]
pub async fn set_global_shortcut_recording(recording: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = state().lock().map_err(|error| {
            log::error!("Failed to update shortcut recorder state: {error}");
            "无法更新快捷键录制状态。".to_string()
        })?;
        current.recording.store(recording, Ordering::Release);
        Ok(())
    })
    .await
    .map_err(|error| {
        log::error!("Shortcut recorder task failed: {error}");
        "无法更新快捷键录制状态。".to_string()
    })?
}

#[tauri::command]
pub async fn get_global_shortcut_status() -> Result<ShortcutStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        state()
            .lock()
            .map(|current| current.status())
            .map_err(|error| {
                log::error!("Failed to read shortcut state: {error}");
                "无法读取快捷键状态。".to_string()
            })
    })
    .await
    .map_err(|error| {
        log::error!("Shortcut status task failed: {error}");
        "无法读取快捷键状态。".to_string()
    })?
}

#[cfg(test)]
#[path = "global_shortcut_tests.rs"]
mod tests;
