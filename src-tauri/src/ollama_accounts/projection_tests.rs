use super::*;
use crate::local_http_api::cache::{self, CachedPluginSnapshot};

pub(super) fn initialize_cache(fixture: &Fixture) {
    cache::init_with_catalog(
        &fixture.dir(),
        &fixture.dir(),
        vec!["ollama".into(), "cursor".into()],
        vec![],
        "test".into(),
    );
}

fn snapshot(provider: &str, plan: &str) -> CachedPluginSnapshot {
    CachedPluginSnapshot {
        provider_id: provider.into(),
        display_name: provider.into(),
        plan: Some(plan.into()),
        lines: vec![],
        started_at: "2026-11-04T13:00:00Z".into(),
        fetched_at: "2026-11-04T13:00:00Z".into(),
    }
}

fn managed_state(plugin: &LoadedPlugin) -> StoredAccounts {
    let mut stored = StoredAccounts::default();
    for (id, identity, plan) in [("a", "a", "Account A"), ("b", "b", "Account B")] {
        let mut account = record(id, &identity.repeat(64));
        account.snapshot = Some(output(plugin, Some(plan.into()), vec![]));
        account.last_updated_at = Some("2026-11-04T13:00:00Z".into());
        stored.connections.push(account);
    }
    stored.primary = Primary::Connection {
        connection_id: "a".into(),
    };
    stored
}

#[test]
#[serial_test::serial]
fn rejecting_an_older_or_uncaptured_generation_preserves_the_new_primary_cache() {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    let mut stored = managed_state(&plugin);
    initialize_cache(&fixture);
    store::write_to(&fixture.path, &stored).unwrap();
    let old_generation = projection_generation(&plugin).unwrap();

    stored.primary = Primary::Connection {
        connection_id: "b".into(),
    };
    stored.projection_revision += 1;
    {
        let _guard = store::lock().unwrap();
        store::write_to(&fixture.path, &stored).unwrap();
    }
    let new_generation = projection_generation(&plugin).unwrap();
    with_projection_guard(&plugin, Some(&new_generation), || {
        cache::replace_cached_account_projection("ollama", Some(snapshot("ollama", "Account B")))
            .unwrap();
    })
    .unwrap();

    for expected in [Some(old_generation.as_str()), None] {
        assert!(
            with_projection_guard(&plugin, expected, || {
                panic!("a superseded or unverified result must not publish")
            })
            .is_err()
        );
        assert_eq!(
            cache::snapshot_for_provider("ollama")
                .unwrap()
                .plan
                .as_deref(),
            Some("Account B")
        );
        assert_eq!(
            cache::load_cache(&fixture.dir())["ollama"].plan.as_deref(),
            Some("Account B")
        );
    }
}

#[test]
#[serial_test::serial]
fn all_projection_entrypoints_clear_unreadable_state_without_affecting_other_providers() {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    initialize_cache(&fixture);
    std::fs::write(&fixture.path, "{damaged synthetic account state").unwrap();
    cache::replace_cached_account_projection("cursor", Some(snapshot("cursor", "Cursor Kept")))
        .unwrap();

    for entrypoint in ["captured", "uncaptured", "startup", "panic"] {
        cache::replace_cached_account_projection("ollama", Some(snapshot("ollama", "Old Account")))
            .unwrap();
        let result = match entrypoint {
            "captured" => with_projection_guard(&plugin, Some("old-generation"), || {
                panic!("unreadable state must not publish")
            }),
            "uncaptured" => with_projection_guard(&plugin, None, || {
                panic!("unverified state must not publish")
            }),
            "startup" => restore_primary_projection(&plugin),
            _ => check_primary_projection(),
        };
        assert!(result.is_err(), "{entrypoint}");
        assert!(
            cache::snapshot_for_provider("ollama").is_none(),
            "{entrypoint}"
        );
        let disk = cache::load_cache(&fixture.dir());
        assert!(!disk.contains_key("ollama"), "{entrypoint}");
        assert_eq!(disk["cursor"].plan.as_deref(), Some("Cursor Kept"));
    }
}

#[test]
#[serial_test::serial]
fn startup_restores_current_primary_without_reentering_the_store_lock() {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    let mut stored = managed_state(&plugin);
    stored.primary = Primary::Connection {
        connection_id: "b".into(),
    };
    store::write_to(&fixture.path, &stored).unwrap();
    initialize_cache(&fixture);
    cache::replace_cached_account_projection("ollama", Some(snapshot("ollama", "Old Account")))
        .unwrap();
    restore_primary_projection(&plugin).unwrap();
    let restored = cache::snapshot_for_provider("ollama").unwrap();
    assert_eq!(restored.plan.as_deref(), Some("Account B"));
    assert_eq!(restored.fetched_at, "2026-11-04T13:00:00Z");

    stored.primary = Primary::Legacy;
    store::write_to(&fixture.path, &stored).unwrap();
    cache::replace_cached_account_projection("ollama", Some(snapshot("ollama", "Legacy Kept")))
        .unwrap();
    restore_primary_projection(&plugin).unwrap();
    // An older provider cache without a current original-connection stamp cannot be attributed.
    assert!(cache::snapshot_for_provider("ollama").is_none());

    stored.primary = Primary::None;
    store::write_to(&fixture.path, &stored).unwrap();
    restore_primary_projection(&plugin).unwrap();
    assert!(cache::snapshot_for_provider("ollama").is_none());
}

#[cfg(unix)]
#[test]
#[serial_test::serial]
fn unreadable_projection_cleanup_keeps_the_store_locked_until_disk_cleanup_finishes() {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    initialize_cache(&fixture);
    cache::replace_cached_account_projection("ollama", Some(snapshot("ollama", "Old Account")))
        .unwrap();
    std::fs::write(&fixture.path, "{damaged synthetic account state").unwrap();

    // Hold the actual cache file lock to pause cleanup between its memory and disk updates.
    let cache_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.dir().join(".usage-api-cache.lock"))
        .unwrap();
    cache_lock.lock().unwrap();
    let path = fixture.path.clone();
    let (completed_tx, completed_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        store::TEST_PATH.with(|value| *value.borrow_mut() = Some(path));
        let result = with_projection_guard(&plugin, Some("old-generation"), || {
            panic!("unreadable state must not publish")
        });
        completed_tx.send(result).unwrap();
        store::TEST_PATH.with(|value| *value.borrow_mut() = None);
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while cache::snapshot_for_provider("ollama").is_some() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let memory_cleared = cache::snapshot_for_provider("ollama").is_none();
    let competing_lock = store::open_lock_file().unwrap();
    let store_still_locked = matches!(
        competing_lock.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    );
    // Release the disk lock before assertions so a regression cannot strand the worker.
    cache_lock.unlock().unwrap();
    assert!(
        completed_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .is_err()
    );
    worker.join().unwrap();
    assert!(memory_cleared);
    assert!(
        store_still_locked,
        "cleanup must retain the account store lock"
    );
    assert!(!cache::load_cache(&fixture.dir()).contains_key("ollama"));
}
