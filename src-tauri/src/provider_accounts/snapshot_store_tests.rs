use super::snapshot_store::{AccountSnapshot, SnapshotStore};
use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use std::path::PathBuf;

fn temporary_app_data_dir(test_name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "openusage-provider-snapshots-{test_name}-{}",
        uuid::Uuid::new_v4()
    ))
}

fn output(value: &str) -> PluginOutput {
    PluginOutput {
        provider_id: "cursor".to_string(),
        display_name: "Cursor".to_string(),
        plan: Some("Pro+".to_string()),
        lines: vec![MetricLine::Text {
            label: "Requests".to_string(),
            value: value.to_string(),
            color: None,
            subtitle: None,
        }],
        icon_url: "data:image/svg+xml;base64,secret-icon".to_string(),
    }
}

#[test]
fn snapshots_are_owned_by_provider_and_account_without_icon_data() {
    let app_data_dir = temporary_app_data_dir("ownership");
    let store = SnapshotStore::new(&app_data_dir);

    store
        .save(
            "cursor",
            "account-a",
            &output("one"),
            "2026-08-24T01:00:00Z",
            "2026-08-24T01:00:05Z",
        )
        .expect("snapshot saves");
    store
        .save(
            "cursor",
            "account-b",
            &output("two"),
            "2026-08-24T01:01:00Z",
            "2026-08-24T01:01:05Z",
        )
        .expect("second account snapshot saves");

    let first = store
        .load("cursor", "account-a")
        .expect("snapshot store reads")
        .expect("first account remains");
    let second = store
        .load("cursor", "account-b")
        .expect("snapshot store reads")
        .expect("second account remains");
    assert_eq!(text_value(&first), "one");
    assert_eq!(text_value(&second), "two");

    let raw = std::fs::read_to_string(app_data_dir.join("provider-account-snapshots.json"))
        .expect("snapshot file exists");
    assert!(!raw.contains("secret-icon"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["version"],
        1
    );
}

#[test]
fn an_older_probe_cannot_overwrite_a_newer_account_snapshot() {
    let app_data_dir = temporary_app_data_dir("ordering");
    let store = SnapshotStore::new(&app_data_dir);
    store
        .save(
            "cursor",
            "account-a",
            &output("newer"),
            "2026-08-24T02:00:00Z",
            "2026-08-24T02:00:01Z",
        )
        .unwrap();

    let accepted = store
        .save(
            "cursor",
            "account-a",
            &output("older"),
            "2026-08-24T01:00:00Z",
            "2026-08-24T03:00:00Z",
        )
        .unwrap();

    assert!(!accepted);
    let stored = store.load("cursor", "account-a").unwrap().unwrap();
    assert_eq!(text_value(&stored), "newer");
}

#[test]
fn stale_process_writers_merge_different_accounts() {
    let app_data_dir = temporary_app_data_dir("merge");
    let first = SnapshotStore::new(&app_data_dir);
    let second = SnapshotStore::new(&app_data_dir);

    first
        .save(
            "cursor",
            "account-a",
            &output("one"),
            "2026-08-24T01:00:00Z",
            "2026-08-24T01:00:01Z",
        )
        .unwrap();
    second
        .save(
            "cursor",
            "account-b",
            &output("two"),
            "2026-08-24T01:00:00Z",
            "2026-08-24T01:00:01Z",
        )
        .unwrap();

    assert!(first.load("cursor", "account-a").unwrap().is_some());
    assert!(first.load("cursor", "account-b").unwrap().is_some());
}

#[test]
fn damaged_snapshot_storage_fails_closed_without_rewriting_the_file() {
    let app_data_dir = temporary_app_data_dir("damaged");
    std::fs::create_dir_all(&app_data_dir).unwrap();
    let path = app_data_dir.join("provider-account-snapshots.json");
    let damaged = b"{not valid account snapshot json";
    std::fs::write(&path, damaged).unwrap();
    let store = SnapshotStore::new(&app_data_dir);

    let error = store
        .save(
            "cursor",
            "account-a",
            &output("value"),
            "2026-08-24T01:00:00Z",
            "2026-08-24T01:00:01Z",
        )
        .expect_err("damaged storage must reject writes");

    assert_eq!(error, "provider account snapshot storage is damaged");
    assert_eq!(std::fs::read(path).unwrap(), damaged);
}

fn text_value(snapshot: &AccountSnapshot) -> &str {
    match &snapshot.lines[0] {
        MetricLine::Text { value, .. } => &value,
        other => panic!("expected text metric, got {other:?}"),
    }
}
