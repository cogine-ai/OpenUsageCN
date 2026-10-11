use super::*;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct FakeBackend {
    registered: HashSet<String>,
    native_handles: HashSet<String>,
    callbacks: HashMap<String, ShortcutCallback>,
    callbacks_during_saves: Vec<HashMap<String, bool>>,
    saved: Option<String>,
    fail_register: bool,
    fail_save_once: bool,
    fail_save_always: bool,
    fail_unregister: Option<String>,
}
impl ShortcutBackend for FakeBackend {
    fn register(&mut self, shortcut: &str, callback: ShortcutCallback) -> Result<(), String> {
        if self.fail_register {
            return Err("occupied".into());
        }
        self.registered.insert(shortcut.into());
        self.native_handles.insert(shortcut.into());
        self.callbacks.insert(shortcut.into(), callback);
        Ok(())
    }
    fn unregister(&mut self, shortcut: &str) -> Result<(), String> {
        let had_handle = self.native_handles.remove(shortcut);
        if self.fail_unregister.as_deref() == Some(shortcut) {
            return Err("unregister failed".into());
        }
        if had_handle {
            self.registered.remove(shortcut);
        }
        self.callbacks.remove(shortcut);
        Ok(())
    }
    fn save(&mut self, shortcut: Option<&str>) -> Result<(), String> {
        self.callbacks_during_saves.push(
            self.callbacks
                .iter()
                .map(|(shortcut, callback)| (shortcut.clone(), callback.enabled()))
                .collect(),
        );
        self.saved = shortcut.map(str::to_string);
        if self.fail_save_always {
            return Err("storage unavailable".into());
        }
        if self.fail_save_once {
            self.fail_save_once = false;
            return Err("disk full".into());
        }
        Ok(())
    }
}
fn existing() -> (ShortcutState, FakeBackend) {
    let shortcut = "Command+Shift+U".to_string();
    let mut state = ShortcutState {
        saved: Some(shortcut.clone()),
        active: Some(shortcut.clone()),
        ..Default::default()
    };
    let callback = state.candidate_callback();
    callback.active.store(true, Ordering::Release);
    state.active_callback = Some(callback.clone());
    (
        state,
        FakeBackend {
            registered: HashSet::from([shortcut.clone()]),
            native_handles: HashSet::from([shortcut.clone()]),
            callbacks: HashMap::from([(shortcut.clone(), callback)]),
            saved: Some(shortcut),
            ..Default::default()
        },
    )
}
#[test]
fn conflict_preserves_old_registration_and_persistence() {
    let (mut state, mut backend) = existing();
    backend.fail_register = true;
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    assert_eq!(state.active, backend.saved);
    assert_eq!(
        backend.registered,
        HashSet::from(["Command+Shift+U".into()])
    );
    assert!(state.status().active);
}
#[test]
fn save_failure_removes_candidate_and_keeps_old() {
    let (mut state, mut backend) = existing();
    backend.fail_save_once = true;
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    assert_eq!(state.active, backend.saved);
    assert_eq!(
        backend.registered,
        HashSet::from(["Command+Shift+U".into()])
    );
}
#[test]
fn unregister_failure_restores_saved_value_and_removes_candidate() {
    let (mut state, mut backend) = existing();
    backend.fail_unregister = state.active.clone();
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    assert_eq!(state.saved, backend.saved);
    assert!(!state.status().active);
    assert_eq!(
        backend.registered,
        HashSet::from(["Command+Shift+U".into()])
    );
}
#[test]
fn successful_replacement_commits_all_three_states() {
    let (mut state, mut backend) = existing();
    let previous_callback = state.active_callback.clone().unwrap();
    let result = apply(&mut state, &mut backend, Some("Control+U".into())).unwrap();
    assert_eq!(result.shortcut.as_deref(), Some("Control+U"));
    assert!(result.active);
    assert_eq!(state.active, backend.saved);
    assert_eq!(backend.registered, HashSet::from(["Control+U".into()]));
    assert!(!previous_callback.enabled());
    assert!(backend.callbacks["Control+U"].enabled());
    assert_eq!(
        backend.callbacks_during_saves[0],
        HashMap::from([
            ("Command+Shift+U".into(), true),
            ("Control+U".into(), false),
        ])
    );
}
#[test]
fn clear_failure_keeps_old_binding_then_success_disables() {
    let (mut state, mut backend) = existing();
    backend.fail_save_once = true;
    assert!(apply(&mut state, &mut backend, None).is_err());
    assert!(state.status().active);
    assert_eq!(backend.registered.len(), 1);
    let result = apply(&mut state, &mut backend, None).unwrap();
    assert!(result.shortcut.is_none());
    assert!(!result.active);
    assert!(backend.registered.is_empty());
    assert!(backend.saved.is_none());
}
#[test]
fn startup_failure_is_not_reported_as_active_and_can_be_repaired() {
    let mut state = ShortcutState::default();
    let mut backend = FakeBackend {
        fail_register: true,
        ..Default::default()
    };
    initialize_state(&mut state, &mut backend, Some("Control+U".into()));
    assert_eq!(state.status().shortcut.as_deref(), Some("Control+U"));
    assert!(!state.status().active);
    assert!(state.status().error.is_some());
    backend.fail_register = false;
    let repaired = apply(&mut state, &mut backend, Some("Control+U".into())).unwrap();
    assert!(repaired.active);
    assert!(repaired.error.is_none());
}

#[test]
fn rollback_failure_is_visible_and_candidate_cannot_replace_active_binding() {
    let (mut state, mut backend) = existing();
    backend.fail_save_always = true;
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    assert!(state.status().error.is_some());
    assert!(state.status().active);
    assert_eq!(
        backend.registered,
        HashSet::from(["Command+Shift+U".into()])
    );
}

#[test]
fn review_regression_existing_press_is_not_lost_while_transaction_lock_is_held() {
    let (state, _) = existing();
    let callback = state.active_callback.clone().unwrap();
    let current = Mutex::new(state);
    let _transaction = current.lock().unwrap();
    assert!(callback.enabled());
}

#[test]
fn review_regression_failed_candidate_cleanup_cannot_be_reported_as_cleared() {
    let (mut state, mut backend) = existing();
    backend.fail_save_once = true;
    backend.fail_unregister = Some("Control+U".into());
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    assert!(backend.registered.contains("Control+U"));
    assert!(!backend.callbacks["Control+U"].enabled());
    assert!(backend.callbacks["Command+Shift+U"].enabled());
    let result = apply(&mut state, &mut backend, None);
    assert!(result.is_err());
    assert!(state.status().error.unwrap().contains("重启"));
    assert!(apply(&mut state, &mut backend, Some("Alt+U".into())).is_err());
    assert!(apply(&mut state, &mut backend, Some("Command+Shift+U".into())).is_err());
    assert_eq!(backend.saved.as_deref(), Some("Command+Shift+U"));
    assert_eq!(backend.registered.len(), 2);
}

#[test]
fn review_regression_failed_previous_unregister_cannot_later_report_released() {
    let (mut state, mut backend) = existing();
    backend.fail_unregister = state.active.clone();
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    // Native macOS unregister removes its handle before reporting the OS error.
    // A later Ok can therefore be a no-op rather than proof of release.
    backend.fail_unregister = None;
    assert!(apply(&mut state, &mut backend, None).is_err());
    assert!(state.status().error.unwrap().contains("重启"));
    assert!(!state.status().active);
}

#[test]
fn review_regression_native_unregister_failure_mutes_unknown_previous_binding() {
    for candidate in [Some("Control+U".into()), None] {
        let (mut state, mut backend) = existing();
        let previous_callback = state.active_callback.clone().unwrap();
        backend.fail_unregister = state.active.clone();
        assert!(apply(&mut state, &mut backend, candidate).is_err());
        assert!(!backend.native_handles.contains("Command+Shift+U"));
        assert!(backend.registered.contains("Command+Shift+U"));
        assert_eq!(state.saved, backend.saved);
        assert!(!state.status().active);
        assert!(!previous_callback.enabled());
        assert!(state.status().error.unwrap().contains("重启"));
    }
}

#[cfg(target_os = "macos")]
#[test]
fn review_regression_invalid_saved_shortcut_preserves_value_and_explains_format() {
    let mut state = ShortcutState::default();
    let mut backend = FakeBackend::default();
    initialize_saved_shortcut(&mut state, &mut backend, Some("Command++U".into()));
    assert_eq!(state.status().shortcut.as_deref(), Some("Command++U"));
    assert!(!state.status().active);
    assert!(state.status().error.unwrap().contains("格式无效"));
    assert!(backend.registered.is_empty());
}
#[cfg(target_os = "macos")]
#[test]
fn command_aliases_normalize_but_control_stays_distinct() {
    assert_eq!(
        normalized_shortcut("CommandOrControl+Shift+U").unwrap(),
        normalized_shortcut("Command+Shift+U").unwrap()
    );
    assert_ne!(
        normalized_shortcut("Command+U").unwrap(),
        normalized_shortcut("Control+U").unwrap()
    );
    assert_eq!(
        normalized_shortcut("CmdOrCtrl+Option+U").unwrap(),
        normalized_shortcut("Command+Alt+U").unwrap()
    );
}

#[test]
fn recording_mutes_existing_and_candidate_callbacks_during_and_after_commit() {
    let (state, mut backend) = existing();
    let old_callback = state.active_callback.clone().unwrap();
    let current = Mutex::new(state);
    let mut transaction = current.lock().unwrap();
    transaction.recording.store(true, Ordering::Release);
    assert!(!old_callback.enabled());
    apply(&mut transaction, &mut backend, Some("Control+U".into())).unwrap();
    assert!(
        backend.callbacks_during_saves[0]
            .values()
            .all(|enabled| !enabled)
    );
    assert!(!backend.callbacks["Control+U"].enabled());
    transaction.recording.store(false, Ordering::Release);
    assert!(backend.callbacks["Control+U"].enabled());
    assert!(!old_callback.enabled());
}

#[test]
fn failed_persistence_rollback_can_be_repaired_without_native_cleanup_failure() {
    let (mut state, mut backend) = existing();
    backend.fail_save_always = true;
    assert!(apply(&mut state, &mut backend, Some("Control+U".into())).is_err());
    assert!(!state.restart_required);
    assert!(backend.callbacks["Command+Shift+U"].enabled());
    backend.fail_save_always = false;
    let repaired = apply(&mut state, &mut backend, Some("Alt+U".into())).unwrap();
    assert!(repaired.error.is_none());
    assert!(repaired.active);
    assert!(backend.callbacks["Alt+U"].enabled());
}
