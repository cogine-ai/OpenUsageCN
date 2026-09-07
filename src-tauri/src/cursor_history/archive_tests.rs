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
fn a_new_billing_period_keeps_the_previous_recorded_period() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let previous = period_history("account-a", 0);
    let current = period_history("account-a", 1);
    store.save("cursor", "account-a", &previous).unwrap();
    store.save("cursor", "account-a", &current).unwrap();

    assert_eq!(
        store.list("cursor", "account-a").unwrap(),
        vec![current.clone(), previous]
    );
    assert_eq!(store.load("cursor", "account-a").unwrap(), Some(current));
    assert!(store.list("cursor", "account-b").unwrap().is_empty());
}

#[test]
fn overlapping_refresh_replaces_a_period_without_adding_counts() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let original = period_history("account-a", 0);
    let mut newer = original.clone();
    newer.coverage.fetched_at_ms += 10;
    newer.coverage.to_ms += 10;
    newer.buckets[0].input_tokens = 25;
    store.save("cursor", "account-a", &original).unwrap();
    store.save("cursor", "account-a", &newer).unwrap();

    assert_eq!(store.list("cursor", "account-a").unwrap(), vec![newer]);
}

#[test]
fn unknown_billing_windows_keep_distinct_coverage_and_replace_exact_refreshes() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let mut previous = period_history("account-a", 0);
    previous.coverage.billing_cycle = None;
    let mut current = previous.clone();
    current.coverage.to_ms += 86_400_000;
    current.coverage.fetched_at_ms += 86_400_000;
    store.save("cursor", "account-a", &previous).unwrap();
    store.save("cursor", "account-a", &current).unwrap();
    assert_eq!(
        store.list("cursor", "account-a").unwrap(),
        vec![current.clone(), previous.clone()]
    );

    let mut refreshed = current;
    refreshed.coverage.fetched_at_ms += 10;
    refreshed.buckets[0].input_tokens = 25;
    store.save("cursor", "account-a", &refreshed).unwrap();
    assert_eq!(
        store.list("cursor", "account-a").unwrap(),
        vec![refreshed, previous]
    );
}

#[test]
fn unknown_billing_windows_keep_their_recorded_time_zone() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let mut previous = period_history("account-a", 0);
    previous.coverage.billing_cycle = None;
    let mut current = previous.clone();
    current.coverage.time_zone = "America/New_York".to_string();
    current.coverage.fetched_at_ms += 10;
    store.save("cursor", "account-a", &previous).unwrap();
    store.save("cursor", "account-a", &current).unwrap();
    assert_eq!(
        store.list("cursor", "account-a").unwrap(),
        vec![current, previous]
    );
}

#[test]
fn unknown_billing_windows_respect_the_twelve_window_limit() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let windows: Vec<_> = (0..15)
        .map(|period| {
            let mut history = period_history("account-a", period);
            history.coverage.billing_cycle = None;
            history
        })
        .collect();
    for history in &windows {
        store.save("cursor", "account-a", history).unwrap();
    }
    let recorded = store.list("cursor", "account-a").unwrap();
    assert_eq!(recorded.len(), 12);
    assert_eq!(recorded.first(), windows.last());
    assert_eq!(recorded.last(), windows.get(3));
}

#[test]
fn retention_keeps_only_the_latest_twelve_recorded_windows() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    for period in 0..15 {
        store
            .save("cursor", "account-a", &period_history("account-a", period))
            .unwrap();
    }
    let recorded = store.list("cursor", "account-a").unwrap();
    assert_eq!(recorded.len(), 12);
    assert_eq!(recorded.first(), Some(&period_history("account-a", 14)));
    assert_eq!(recorded.last(), Some(&period_history("account-a", 3)));
}

#[test]
fn a_v1_snapshot_remains_readable_and_is_preserved_during_migration() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-archive-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let old = super::store_tests::complete_history("account-a", 1_700_086_400_001);
    let path = store.document_path("cursor", "account-a").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        serde_json::to_string(&serde_json::json!({"version": 1, "history": old})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store.list("cursor", "account-a").unwrap(),
        vec![old.clone()]
    );

    let current = period_history("account-a", 1);
    store.save("cursor", "account-a", &current).unwrap();
    assert_eq!(
        store.list("cursor", "account-a").unwrap(),
        vec![current, old]
    );
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(saved["version"], 2);
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
            store.list("cursor", "account-a"),
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
        assert_eq!(store.list("cursor", "account-a").unwrap(), vec![current]);
        assert_eq!(std::fs::read(&backups[0]).unwrap(), damaged.as_bytes());
    }
}
