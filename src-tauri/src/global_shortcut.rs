use serde::Serialize;
use std::sync::{Mutex, OnceLock};

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
    recording: bool,
}

impl ShortcutState {
    fn status(&self) -> ShortcutStatus {
        ShortcutStatus {
            shortcut: self.saved.clone(),
            active: self.saved.is_some() && self.saved == self.active,
            error: self.error.clone(),
        }
    }
}

fn state() -> &'static Mutex<ShortcutState> {
    static STATE: OnceLock<Mutex<ShortcutState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ShortcutState::default()))
}

trait ShortcutBackend {
    fn register(&mut self, shortcut: &str) -> Result<(), String>;
    fn unregister(&mut self, shortcut: &str) -> Result<(), String>;
    fn save(&mut self, shortcut: Option<&str>) -> Result<(), String>;
}

fn rollback(
    backend: &mut impl ShortcutBackend,
    previous: Option<&str>,
    candidate: Option<&str>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Some(candidate) = candidate {
        if let Err(error) = backend.unregister(candidate) {
            errors.push(error);
        }
    }
    if let Err(error) = backend.save(previous) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn apply(
    state: &mut ShortcutState,
    backend: &mut impl ShortcutBackend,
    candidate: Option<String>,
) -> Result<ShortcutStatus, String> {
    if state.saved == candidate && state.active == candidate && state.error.is_none() {
        return Ok(state.status());
    }
    let newly_registered = candidate
        .as_deref()
        .filter(|value| Some(*value) != state.active.as_deref());
    if let Some(value) = newly_registered {
        backend.register(value).map_err(|error| {
            log::error!("Failed to register candidate shortcut: {error}");
            "此组合无法使用，请试另一个快捷键。".to_string()
        })?;
    }
    if let Err(error) = backend.save(candidate.as_deref()) {
        log::error!("Failed to persist candidate shortcut: {error}");
        if let Err(rollback_error) = rollback(backend, state.saved.as_deref(), newly_registered) {
            log::error!("Failed to roll back shortcut persistence: {rollback_error}");
            let message = "快捷键保存状态无法确认，请重新设置。".to_string();
            state.error = Some(message.clone());
            return Err(message);
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
                log::error!("Failed to roll back shortcut replacement: {rollback_error}");
                let message = "快捷键保存状态无法确认，请重新设置。".to_string();
                state.error = Some(message.clone());
                return Err(message);
            }
            return Err("无法替换快捷键，请重试。".into());
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
    state.error = None;
    if let Some(shortcut) = saved {
        match backend.register(&shortcut) {
            Ok(()) => state.active = Some(shortcut),
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
    fn register(&mut self, shortcut: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as EventState};
        let expected = shortcut.to_string();
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state != EventState::Pressed {
                    return;
                }
                let enabled = match state().try_lock() {
                    Ok(current) => {
                        !current.recording && current.active.as_deref() == Some(expected.as_str())
                    }
                    Err(std::sync::TryLockError::WouldBlock) => false,
                    Err(error) => {
                        log::error!("Failed to read shortcut registration state: {error}");
                        false
                    }
                };
                if enabled {
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
        .and_then(|store| {
            store
                .get("globalShortcut")
                .and_then(|value| value.as_str().map(str::to_string))
                .filter(|value| !value.trim().is_empty())
                .map(|value| normalized_shortcut(value.trim()))
                .transpose()
        });
    match saved {
        Ok(value) => initialize_state(&mut current, &mut NativeBackend(app), value),
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
        let mut current = state().lock().map_err(|error| {
            log::error!("Failed to update shortcut recorder state: {error}");
            "无法更新快捷键录制状态。".to_string()
        })?;
        current.recording = recording;
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
