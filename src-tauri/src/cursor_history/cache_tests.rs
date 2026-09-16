use super::*;

pub(super) fn period_history(account_id: &str, period: i64) -> CompleteHistory {
    let start_ms = 1_700_000_000_000 + period * 30 * 86_400_000;
    let mut history = super::store_tests::complete_history(account_id, start_ms + 86_400_000);
    history.coverage.from_ms = start_ms;
    history.coverage.to_ms = start_ms + 86_400_000;
    history.coverage.billing_cycle = Some(BillingCycle {
        start_ms,
        end_ms: start_ms + 30 * 86_400_000,
    });
    history
}

#[test]
fn each_new_window_replaces_the_entire_cache_without_adding_counts() {
    let root = std::env::temp_dir().join(format!("cursor-cache-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    for period in 0..15 {
        let mut current = period_history("account-a", period);
        current.buckets[0].input_tokens = 25;
        store.save("cursor", "account-a", &current).unwrap();
        assert_eq!(store.load("cursor", "account-a").unwrap(), Some(current));
        let saved: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(store.document_path("cursor", "account-a").unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["version"], 3);
        assert!(saved.get("archived").is_none());
    }
}

#[test]
fn overlapping_results_replace_instead_of_merging_or_summing() {
    let root = std::env::temp_dir().join(format!("cursor-cache-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let previous = period_history("account-a", 0);
    let mut current = previous.clone();
    current.coverage.from_ms += 100;
    current.coverage.to_ms += 100;
    current.coverage.fetched_at_ms += 100;
    current.buckets[0].input_tokens = 2;
    store.save("cursor", "account-a", &previous).unwrap();
    store.save("cursor", "account-a", &current).unwrap();
    assert_eq!(store.load("cursor", "account-a").unwrap(), Some(current));
}

#[test]
fn legacy_files_expose_only_latest_and_discard_archives_on_successful_save() {
    for version in [1, 2] {
        let root = std::env::temp_dir().join(format!("cursor-cache-{}", uuid::Uuid::new_v4()));
        let store = HistoryStore::new(&root);
        let latest = period_history("account-a", 1);
        let mut document = serde_json::json!({"version": version, "history": latest});
        if version == 2 {
            document["archived"] = serde_json::json!([period_history("account-a", 0)]);
        }
        let path = store.document_path("cursor", "account-a").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = serde_json::to_string(&document).unwrap();
        std::fs::write(&path, &original).unwrap();
        assert_eq!(store.load("cursor", "account-a").unwrap(), Some(latest));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let current = period_history("account-a", 2);
        store.save("cursor", "account-a", &current).unwrap();
        assert_eq!(store.load("cursor", "account-a").unwrap(), Some(current));
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(saved["version"], 3);
        assert!(saved.get("archived").is_none());
    }
}

#[test]
fn clearing_account_cache_is_idempotent_and_cannot_reconnect_old_results() {
    let root = std::env::temp_dir().join(format!("cursor-cache-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    store
        .save("cursor", "account-a", &period_history("account-a", 0))
        .unwrap();
    let other = period_history("account-b", 0);
    store.save("cursor", "account-b", &other).unwrap();
    store.clear("cursor", "account-a").unwrap();
    store.clear("cursor", "account-a").unwrap();
    assert_eq!(store.load("cursor", "account-a").unwrap(), None);
    assert_eq!(store.load("cursor", "account-b").unwrap(), Some(other));
    assert_eq!(
        store.clear("cursor", "../account-b"),
        Err(HistoryError::InvalidStorageKey)
    );
    let reconnected = period_history("account-a", 3);
    store.save("cursor", "account-a", &reconnected).unwrap();
    assert_eq!(
        store.load("cursor", "account-a").unwrap(),
        Some(reconnected)
    );
}

#[test]
fn damaged_v2_archives_are_preserved_and_a_later_save_can_recover() {
    for archived in [
        serde_json::Value::Null,
        serde_json::json!([period_history("account-b", 0)]),
        serde_json::json!([period_history("account-a", 1)]),
    ] {
        let root =
            std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
        let store = HistoryStore::new(&root);
        let path = store.document_path("cursor", "account-a").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let damaged = serde_json::to_string(&serde_json::json!({"version": 2, "history": period_history("account-a", 1), "archived": archived})).unwrap();
        std::fs::write(&path, &damaged).unwrap();
        assert_eq!(
            store.load("cursor", "account-a"),
            Err(HistoryError::StorageInvalid)
        );
        let backups: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|entry| {
                entry
                    .extension()
                    .is_some_and(|extension| extension == "invalid")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(&backups[0]).unwrap(), damaged.as_bytes());
        assert!(!path.exists());
        let current = period_history("account-a", 2);
        store.save("cursor", "account-a", &current).unwrap();
        assert_eq!(store.load("cursor", "account-a").unwrap(), Some(current));
        assert_eq!(std::fs::read(&backups[0]).unwrap(), damaged.as_bytes());
    }
}

#[test]
fn removal_clears_only_exact_account_quarantines() {
    let root = std::env::temp_dir().join(format!("cursor-cache-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    store
        .save("cursor", "account-a", &period_history("account-a", 0))
        .unwrap();
    let other = period_history("account-b", 0);
    store.save("cursor", "account-b", &other).unwrap();
    let path = store.document_path("cursor", "account-a").unwrap();
    let parent = path.parent().unwrap();
    let quarantines: Vec<_> = (0..2)
        .map(|_| parent.join(format!("account-a.json.{}.invalid", uuid::Uuid::new_v4())))
        .collect();
    for quarantine in &quarantines {
        std::fs::write(quarantine, "account A cached data").unwrap();
    }
    let preserved = [
        parent.join(format!("account-b.json.{}.invalid", uuid::Uuid::new_v4())),
        parent.join("account-a.json.notes.invalid"),
        parent.join(format!("account-aa.json.{}.invalid", uuid::Uuid::new_v4())),
    ];
    for file in &preserved {
        std::fs::write(file, "untouched").unwrap();
    }
    store.clear("cursor", "account-a").unwrap();
    store.clear("cursor", "account-a").unwrap();
    assert!(!path.exists());
    assert!(quarantines.iter().all(|file| !file.exists()));
    for file in preserved {
        assert_eq!(std::fs::read_to_string(file).unwrap(), "untouched");
    }
    assert_eq!(store.load("cursor", "account-b").unwrap(), Some(other));
}
