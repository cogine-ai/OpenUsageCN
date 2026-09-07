use super::{HistoryError, HistoryStore, export};

#[test]
fn unknown_billing_period_exports_coverage_without_inventing_cycle_dates() {
    let mut history = super::archive_tests::period_history("account-a", 0);
    history.coverage.billing_cycle = None;
    let csv = export::history_csv(&history).unwrap();
    let summary = csv.lines().nth(1).unwrap();
    assert!(summary.contains("\"Asia/Taipei\",\"\",\"\",\"2023-11-14T22:13:20Z\""));
    assert!(!summary.contains("2023-12-14T22:13:20Z"));
}

#[test]
fn csv_carries_exact_coverage_and_keeps_cost_meanings_separate() {
    let history = super::archive_tests::period_history("account-a", 0);
    let csv = export::history_csv(&history).unwrap();
    let rows: Vec<_> = csv.lines().collect();
    assert_eq!(rows.len(), 3);
    assert!(rows[0].contains("\"Billing Cycle Start UTC\""));
    assert!(rows[0].contains("\"Coverage From UTC\""));
    assert!(rows[1].contains("https://cursor.com/api/dashboard/get-filtered-usage-events"));
    assert!(rows[1].contains("Recorded Window Only; Not An Invoice"));
    assert!(rows[1].ends_with("\"0.5\",\"Complete\""));
    assert!(rows[2].ends_with("\"0.25\",\"Complete\",\"\",\"\""));
    assert!(csv.ends_with("\r\n"));
}

#[test]
fn csv_escapes_multiline_names_and_neutralizes_formula_prefixes() {
    for model in [
        "=SUM(1,2)",
        "+1",
        "-1",
        "@SUM(1)",
        "\t=1",
        "\r=1",
        "\n=1",
        "  =1",
        "＝1",
        "＋1",
        "－1",
        "＠1",
    ] {
        let mut history = super::archive_tests::period_history("account-a", 0);
        history.buckets[0].model_name = model.to_string();
        let csv = export::history_csv(&history).unwrap();
        assert!(
            csv.contains(&format!("\"Text: {model}\"")),
            "model: {model}"
        );
        assert_eq!(history.buckets[0].model_name, model);
    }
    let mut history = super::archive_tests::period_history("account-a", 0);
    history.buckets[0].model_name = "model,\"quoted\"\nnext".to_string();
    assert!(
        export::history_csv(&history)
            .unwrap()
            .contains("\"model,\"\"quoted\"\"\nnext\"")
    );
}

#[test]
fn csv_creation_cannot_overwrite_an_existing_file() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-export-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = export::write_new_csv(&root, "existing.csv", "original").unwrap();
    assert_eq!(
        export::write_new_csv(&root, "existing.csv", "replacement"),
        Err(HistoryError::StorageWrite)
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), "original");
}

#[test]
fn export_uses_only_the_selected_stored_account_window_and_a_generated_filename() {
    let root =
        std::env::temp_dir().join(format!("openusage-cursor-export-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let mut old = super::archive_tests::period_history("account-a", 0);
    old.buckets[0].model_name = "../../attacker".to_string();
    store.save("cursor", "account-a", &old).unwrap();
    store
        .save(
            "cursor",
            "account-a",
            &super::archive_tests::period_history("account-a", 1),
        )
        .unwrap();
    let key = export::SnapshotKey {
        from_ms: old.coverage.from_ms,
        to_ms: old.coverage.to_ms,
        fetched_at_ms: old.coverage.fetched_at_ms,
    };
    let path = export::export_stored_snapshot(&store, "cursor", "account-a", &key, &root).unwrap();
    assert_eq!(path.parent(), Some(root.as_path()));
    assert!(
        path.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("cursor-history-")
    );
    assert!(
        std::fs::read_to_string(path)
            .unwrap()
            .contains("../../attacker")
    );
    assert_eq!(
        export::export_stored_snapshot(&store, "cursor", "account-b", &key, &root),
        Err(HistoryError::StorageRead)
    );
}
