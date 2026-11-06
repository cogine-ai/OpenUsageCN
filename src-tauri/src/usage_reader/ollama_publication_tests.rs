use super::*;
use crate::local_http_api::cache::{self, CachedPluginSnapshot};

#[test]
#[serial_test::serial]
fn final_ollama_publication_preserves_the_selected_rows_actual_fetch_time() {
    let directory = tempfile::tempdir().unwrap();
    cache::init_with_catalog(
        directory.path(),
        directory.path(),
        vec!["ollama".into()],
        vec![],
        "test".into(),
    );
    let original = CachedPluginSnapshot {
        provider_id: "ollama".into(),
        display_name: "Ollama Cloud".into(),
        plan: Some("Primary".into()),
        lines: vec![],
        started_at: "2026-11-04T00:00:00Z".into(),
        fetched_at: "2026-11-04T00:00:00Z".into(),
        config_fingerprint: None,
    };
    cache::replace_cached_account_projection("ollama", Some(original.clone())).unwrap();
    let output = PluginOutput {
        provider_id: "ollama".into(),
        display_name: "Ollama Cloud".into(),
        icon_url: String::new(),
        plan: Some("Primary".into()),
        lines: vec![],
    };
    publish_cli_probe("ollama", &output, time::OffsetDateTime::now_utc());
    let memory = cache::snapshot_for_provider("ollama").unwrap();
    let disk = cache::load_cache(directory.path())
        .remove("ollama")
        .unwrap();
    for snapshot in [memory, disk] {
        assert_eq!(snapshot.started_at, original.started_at);
        assert_eq!(snapshot.fetched_at, original.fetched_at);
        assert_eq!(snapshot.plan, original.plan);
    }
}
