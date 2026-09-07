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
fn damaged_v2_or_wrong_account_archives_fail_without_overwriting_the_file() {
    for archived in [
        serde_json::Value::Null,
        serde_json::json!([period_history("account-b", 0)]),
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
        assert_eq!(
            store.save("cursor", "account-a", &period_history("account-a", 2)),
            Err(HistoryError::StorageInvalid)
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), damaged);
    }
}
