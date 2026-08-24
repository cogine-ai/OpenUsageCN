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
    assert_eq!(stored["version"], 1);
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
