use super::*;

#[test]
#[serial_test::serial]
fn failed_primary_refresh_retains_cached_quota_and_does_not_invalidate_projection() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: id.clone(),
        },
    )
    .unwrap();
    let stamp = projection_generation(&p).unwrap();
    let original = serde_json::to_string(&store::read().unwrap().connections[0].snapshot).unwrap();
    let mut limited = p.clone();
    limited.entry_script = "globalThis.__openusage_ollama_account=()=>{throw JSON.stringify({code:'rateLimited',message:'private-error'})}".into();
    refresh(
        &limited,
        &f.dir(),
        "test",
        &id,
        std::time::Instant::now() + std::time::Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(projection_generation(&p).unwrap(), stamp);
    let current = store::read().unwrap();
    assert_eq!(
        serde_json::to_string(&current.connections[0].snapshot).unwrap(),
        original
    );
    assert_eq!(
        current.connections[0].error.as_ref().unwrap().code,
        "rateLimited"
    );
    let output = run_primary_probe(&limited, &f.dir(), "test");
    assert!(matches!(&output.lines[0], MetricLine::Badge { label, .. } if label == "Error"));
    assert_eq!(projection_generation(&p).unwrap(), stamp);
}

#[test]
#[serial_test::serial]
fn projection_guard_prevents_mutation_until_publication_finishes() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: id.clone(),
        },
    )
    .unwrap();
    let stamp = projection_generation(&p).unwrap();
    let (start_tx, start_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let path = f.path.clone();
    let dir = f.dir();
    let other_plugin = p.clone();
    let worker = std::thread::spawn(move || {
        store::TEST_PATH.with(|p| *p.borrow_mut() = Some(path));
        start_rx.recv().unwrap();
        commands::perform(
            &other_plugin,
            &dir,
            "test",
            Operation::Remove { connection_id: id },
        )
        .unwrap();
        done_tx.send(()).unwrap();
        store::TEST_PATH.with(|p| *p.borrow_mut() = None);
    });
    with_projection_guard(&p, Some(&stamp), || {
        start_tx.send(()).unwrap();
        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(30))
                .is_err()
        );
    })
    .unwrap();
    done_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    worker.join().unwrap();
    assert_eq!(store::read().unwrap().primary, Primary::None);
    assert!(with_projection_guard(&p, Some(&stamp), || ()).is_err());
}

#[test]
#[serial_test::serial]
fn failed_projection_cleanup_preserves_primary_and_key_bytes() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    let original = std::fs::read(&f.path).unwrap();
    store::FAIL_CLEAR.with(|fail| fail.set(true));
    let failed = commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: id.clone(),
        },
    );
    store::FAIL_CLEAR.with(|fail| fail.set(false));
    assert!(failed.is_err());
    assert_eq!(std::fs::read(&f.path).unwrap(), original);
    assert_eq!(store::read().unwrap().primary, Primary::Legacy);
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: id.clone(),
        },
    )
    .unwrap();
    let token =
        commands::verify(&p, &f.dir(), "test", "synthetic-new-key".into(), Some(id)).unwrap();
    let original = std::fs::read(&f.path).unwrap();
    store::FAIL_CLEAR.with(|fail| fail.set(true));
    let failed = commands::save(&p, &token.verification_id, "Personal".into(), false);
    store::FAIL_CLEAR.with(|fail| fail.set(false));
    assert!(failed.is_err());
    assert_eq!(std::fs::read(&f.path).unwrap(), original);
}

#[test]
#[serial_test::serial]
fn legacy_configuration_is_not_written_after_projection_cleanup_failure() {
    let _f = Fixture::new();
    let called = std::cell::Cell::new(false);
    store::FAIL_CLEAR.with(|fail| fail.set(true));
    let result = with_legacy_configuration_change(|| {
        called.set(true);
        Ok(())
    });
    store::FAIL_CLEAR.with(|fail| fail.set(false));
    assert!(result.is_err());
    assert!(!called.get());
}

#[test]
fn separate_open_file_handles_cannot_modify_a_locked_account_store() {
    let _f = Fixture::new();
    let guard = store::lock().unwrap();
    let second = store::open_lock_file().unwrap();
    assert!(matches!(
        second.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    drop(guard);
    second.try_lock().unwrap();
    second.unlock().unwrap();
}

#[test]
fn independent_refresh_handles_serialize_the_same_connection_only() {
    let _f = Fixture::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    let guard = store::acquire_refresh("one", deadline).unwrap();
    let same = store::open_refresh_lock_file("one").unwrap();
    let other = store::open_refresh_lock_file("two").unwrap();
    assert!(matches!(
        same.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    other.try_lock().unwrap();
    other.unlock().unwrap();
    drop(guard);
    same.try_lock().unwrap();
    same.unlock().unwrap();
}

#[test]
#[serial_test::serial]
fn cli_probe_uses_managed_primary_and_never_falls_back_after_removal() {
    let f = Fixture::new();
    // This plugin intentionally has no generic legacy probe entrypoint.
    let p = plugin(&"a".repeat(64), 24);
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: id.clone(),
        },
    )
    .unwrap();
    let result = crate::usage_reader::prepare_ollama_probe(
        &p,
        &f.dir(),
        "test",
        time::OffsetDateTime::now_utc(),
    );
    match result {
        crate::usage_reader::PendingUsageProbe::Ollama {
            output, generation, ..
        } => {
            assert!(generation.is_some());
            assert!(
                matches!(output.lines.first(), Some(MetricLine::Progress {used,..}) if *used == 24.0)
            );
        }
        _ => panic!("CLI must use the guarded Ollama path"),
    }
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::Remove { connection_id: id },
    )
    .unwrap();
    let result = crate::usage_reader::prepare_ollama_probe(
        &p,
        &f.dir(),
        "test",
        time::OffsetDateTime::now_utc(),
    );
    match result {
        crate::usage_reader::PendingUsageProbe::Ollama { output, .. } => {
            assert!(
                matches!(output.lines.first(), Some(MetricLine::Badge {label,text,..}) if label == "Error" && text.contains("主账号"))
            );
        }
        _ => panic!("CLI must not fall back to a legacy key"),
    }
}

#[test]
#[serial_test::serial]
fn cached_projection_keeps_the_actual_original_update_time() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary { connection_id: id },
    )
    .unwrap();
    let mut stored = store::read().unwrap();
    stored.connections[0].last_updated_at = Some("2026-01-01T00:00:00Z".into());
    stored.connections[0].error = Some(AccountError {
        code: "rateLimited".into(),
        message: "Cached data".into(),
    });
    store::write_to(&f.path, &stored).unwrap();
    let cached = primary_cached_snapshot().unwrap().unwrap();
    assert_eq!(cached.fetched_at, "2026-01-01T00:00:00Z");
    assert_eq!(cached.started_at, "2026-01-01T00:00:00Z");
}
