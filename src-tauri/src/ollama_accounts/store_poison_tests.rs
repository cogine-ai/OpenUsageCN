use super::*;

#[test]
#[serial_test::serial]
fn recovering_a_poisoned_store_preserves_pending_verification() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ollama-accounts.json");
    let previous_path = TEST_PATH.with(|value| value.replace(Some(path)));
    let verification_id = uuid::Uuid::new_v4().to_string();
    let created = Instant::now();

    let panicked = std::panic::catch_unwind(|| {
        let mut guard = lock().unwrap();
        guard.pending.insert(
            verification_id.clone(),
            Pending {
                api_key: "synthetic-pending-key".into(),
                target: Some(("synthetic-connection".into(), 7)),
                probe: serde_json::from_value(serde_json::json!({
                    "identity": { "fingerprint": "a".repeat(64), "name": "Synthetic User" },
                    "plan": "Test",
                    "lines": []
                }))
                .unwrap(),
                created,
            },
        );
        panic!("synthetic worker panic while holding account state");
    });
    assert!(panicked.is_err());

    {
        let guard = lock().expect("poisoned account state must remain usable");
        assert!(
            !transient_state().is_poisoned(),
            "recovery must clear the poison marker"
        );
        let pending = guard
            .pending
            .get(&verification_id)
            .expect("recovery must retain the pending verification");
        assert_eq!(pending.api_key, "synthetic-pending-key");
        assert_eq!(pending.target, Some(("synthetic-connection".into(), 7)));
        assert_eq!(pending.probe.identity.fingerprint, "a".repeat(64));
        assert_eq!(pending.created, created);
    }
    {
        let mut guard = lock().expect("subsequent acquisitions must remain healthy");
        assert!(!transient_state().is_poisoned());
        assert_eq!(
            guard.pending.remove(&verification_id).unwrap().api_key,
            "synthetic-pending-key"
        );
    }
    TEST_PATH.with(|value| *value.borrow_mut() = previous_path);
}
