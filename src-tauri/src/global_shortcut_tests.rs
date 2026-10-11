use super::*;
use std::collections::HashSet;

#[derive(Default)]
struct FakeBackend {
    registered: HashSet<String>,
    saved: Option<String>,
    fail_register: bool,
    fail_save_once: bool,
    fail_save_always: bool,
    fail_unregister: Option<String>,
}
impl ShortcutBackend for FakeBackend {
    fn register(&mut self, shortcut: &str) -> Result<(), String> {
        if self.fail_register {
            return Err("occupied".into());
        }
        self.registered.insert(shortcut.into());
        Ok(())
    }
    fn unregister(&mut self, shortcut: &str) -> Result<(), String> {
        if self.fail_unregister.as_deref() == Some(shortcut) {
            return Err("unregister failed".into());
        }
        self.registered.remove(shortcut);
        Ok(())
    }
    fn save(&mut self, shortcut: Option<&str>) -> Result<(), String> {
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
    (
        ShortcutState {
            saved: Some(shortcut.clone()),
            active: Some(shortcut.clone()),
            error: None,
            recording: false,
        },
        FakeBackend {
            registered: HashSet::from([shortcut.clone()]),
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
    assert_eq!(state.active, backend.saved);
    assert_eq!(
        backend.registered,
        HashSet::from(["Command+Shift+U".into()])
    );
}
#[test]
fn successful_replacement_commits_all_three_states() {
    let (mut state, mut backend) = existing();
    let result = apply(&mut state, &mut backend, Some("Control+U".into())).unwrap();
    assert_eq!(result.shortcut.as_deref(), Some("Control+U"));
    assert!(result.active);
    assert_eq!(state.active, backend.saved);
    assert_eq!(backend.registered, HashSet::from(["Control+U".into()]));
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
}
