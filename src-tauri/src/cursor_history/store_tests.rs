use std::path::PathBuf;

use super::*;

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!("openusage-cursor-history-{}", uuid::Uuid::new_v4()))
}

pub(super) fn complete_history(account_id: &str, fetched_at_ms: i64) -> CompleteHistory {
    CompleteHistory {
        account_id: account_id.to_string(),
        buckets: vec![ModelUsageBucket {
            local_date: "2026-08-24".to_string(),
            model_name: "raw-model".to_string(),
            input_tokens: 10,
            output_tokens: 20,
            cache_write_tokens: 30,
            cache_read_tokens: 40,
            request_count: 1,
            known_list_cost_usd: Some(0.25),
            list_cost_coverage: ListCostCoverage::Complete,
        }],
        coverage: HistoryCoverage {
            from_ms: 1_700_000_000_000,
            to_ms: 1_700_086_400_000,
            fetched_at_ms,
            time_zone: "Asia/Taipei".to_string(),
            complete: true,
            scope: HistoryScope::SessionVisible,
            billing_cycle: None,
        },
        totals: HistoryTotals {
            metered_charged_usd: Some(0.5),
            metered_coverage: MeteredCoverage::Complete,
        },
    }
}

#[test]
fn complete_account_snapshot_round_trips_at_the_account_scoped_path() {
    let root = temp_root();
    let store = HistoryStore::new(&root);
    let expected = complete_history("account-a", 1_700_086_400_001);

    store
        .save("cursor", "account-a", &expected)
        .expect("complete aggregate should persist");

    assert_eq!(
        store.load("cursor", "account-a").expect("load snapshot"),
        Some(expected)
    );
    assert!(
        root.join("provider-history/cursor/account-a.json")
            .is_file()
    );
    let stored: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("provider-history/cursor/account-a.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stored["version"], 3);
    assert_eq!(stored["history"]["accountId"], "account-a");
}

#[test]
fn rejected_incomplete_refresh_cannot_replace_the_previous_snapshot() {
    let root = temp_root();
    let store = HistoryStore::new(&root);
    let previous = complete_history("account-a", 1_700_086_400_001);
    store
        .save("cursor", "account-a", &previous)
        .expect("seed previous snapshot");
    let mut incomplete = complete_history("account-a", 1_700_086_400_999);
    incomplete.coverage.complete = false;

    assert_eq!(
        store.save("cursor", "account-a", &incomplete),
        Err(HistoryError::IncompleteSnapshot)
    );
    assert_eq!(
        store.load("cursor", "account-a").expect("old snapshot"),
        Some(previous)
    );
}

#[test]
fn an_older_complete_refresh_cannot_replace_a_newer_account_snapshot() {
    let root = temp_root();
    let store = HistoryStore::new(&root);
    let newer = complete_history("account-a", 1_800_000_000_000);
    let older = complete_history("account-a", 1_799_999_000_000);

    store
        .save("cursor", "account-a", &newer)
        .expect("newer snapshot is stored");
    store
        .save("cursor", "account-a", &older)
        .expect("older completion is ignored without corrupting storage");

    assert_eq!(
        store.load("cursor", "account-a").expect("saved snapshot"),
        Some(newer)
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn aggregate_storage_contains_no_raw_rows_or_ownership_fields() {
    let root = temp_root();
    let store = HistoryStore::new(&root);
    store
        .save(
            "cursor",
            "account-a",
            &complete_history("account-a", 1_700_086_400_001),
        )
        .expect("save aggregate");
    let stored = std::fs::read_to_string(root.join("provider-history/cursor/account-a.json"))
        .expect("stored aggregate document");

    for forbidden in [
        "usageEventsDisplay",
        "tokenUsage",
        "owningUser",
        "owningTeam",
        "cookie",
        "subject",
    ] {
        assert!(!stored.contains(forbidden), "forbidden field: {forbidden}");
    }
}

#[test]
fn storage_keys_cannot_escape_the_provider_history_root() {
    let store = HistoryStore::new(&temp_root());
    assert_eq!(
        store.document_path("cursor", "../account"),
        Err(HistoryError::InvalidStorageKey)
    );
    assert_eq!(
        store.document_path("cursor/other", "account"),
        Err(HistoryError::InvalidStorageKey)
    );
}

#[test]
fn a_save_that_finds_invalid_supported_history_keeps_the_first_error_and_original_bytes() {
    let root = temp_root();
    let store = HistoryStore::new(&root);
    let path = store.document_path("cursor", "account-a").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let damaged = b"{ \n  \"version\": 1, \"history\": null\n}\n";
    std::fs::write(&path, damaged).unwrap();
    let current = complete_history("account-a", 1_700_086_400_001);

    assert_eq!(
        store.save("cursor", "account-a", &current),
        Err(HistoryError::StorageInvalid)
    );
    let files: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].extension().unwrap(), "invalid");
    assert_eq!(std::fs::read(&files[0]).unwrap(), damaged);
    assert!(!path.exists());

    store.save("cursor", "account-a", &current).unwrap();
    assert_eq!(store.load("cursor", "account-a").unwrap(), Some(current));
    assert_eq!(std::fs::read(&files[0]).unwrap(), damaged);
}

#[test]
fn future_versions_and_unrecognized_formats_are_never_quarantined_or_overwritten() {
    for content in [
        r#"{"version":4,"history":null,"newFormat":[]}"#,
        r#"{"version":10000000000,"history":null}"#,
        r#"{"history":null}"#,
        "not JSON",
    ] {
        let root = temp_root();
        let store = HistoryStore::new(&root);
        let path = store.document_path("cursor", "account-a").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        assert_eq!(
            store.load("cursor", "account-a"),
            Err(HistoryError::StorageInvalid)
        );
        assert_eq!(
            store.save(
                "cursor",
                "account-a",
                &complete_history("account-a", 1_700_086_400_001)
            ),
            Err(HistoryError::StorageInvalid)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }
}

#[cfg(unix)]
#[test]
fn unreadable_history_and_failed_quarantine_leave_the_original_in_place() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return; // Root bypasses these filesystem permission boundaries.
    }
    let root = temp_root();
    let store = HistoryStore::new(&root);
    let path = store.document_path("cursor", "account-a").unwrap();
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent).unwrap();
    let damaged = b"{\"version\":1,\"history\":null}";
    std::fs::write(&path, damaged).unwrap();

    let original = std::fs::metadata(&path).unwrap().permissions();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = store.load("cursor", "account-a");
    std::fs::set_permissions(&path, original).unwrap();
    assert_eq!(unreadable, Err(HistoryError::StorageRead));
    assert_eq!(std::fs::read(&path).unwrap(), damaged);
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 1);

    let original = std::fs::metadata(parent).unwrap().permissions();
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o500)).unwrap();
    let quarantine_failed = store.load("cursor", "account-a");
    std::fs::set_permissions(parent, original).unwrap();
    assert_eq!(quarantine_failed, Err(HistoryError::StorageWrite));
    assert_eq!(std::fs::read(&path).unwrap(), damaged);
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 1);
}

#[test]
fn loading_waits_for_the_writer_before_deciding_to_quarantine() {
    use std::sync::mpsc;
    use std::time::Duration;

    let root = temp_root();
    let store = HistoryStore::new(&root);
    let path = store.document_path("cursor", "account-a").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"{\"version\":1,\"history\":null}").unwrap();
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(root.join("provider-history/.history.lock"))
        .unwrap();
    lock.lock().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        result_tx.send(store.load("cursor", "account-a")).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(matches!(
        result_rx.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    let current = complete_history("account-a", 1_700_086_400_001);
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "version": 2, "history": current, "archived": []
        }))
        .unwrap(),
    )
    .unwrap();
    drop(lock);
    assert_eq!(
        result_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap(),
        Some(current)
    );
    reader.join().unwrap();
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
}
