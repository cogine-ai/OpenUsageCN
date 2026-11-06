use super::super::{
    account_projection, cache_state, init, load_cache, snapshot_for_provider, UsageApiCacheFile,
};
use super::*;
use crate::local_http_api::limits::{current_envelope, ProviderLimitCatalog};
use serde_json::json;
use std::collections::HashMap;

struct ConfigFixture {
    path: std::path::PathBuf,
    original: Option<Vec<u8>>,
}
impl ConfigFixture {
    fn new() -> Self {
        let path = crate::provider_config::config_path().unwrap();
        assert!(path
            .to_string_lossy()
            .contains("openusage-provider-config-tests-"));
        let original = std::fs::read(&path).ok();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        Self { path, original }
    }
    fn write(&self, token: Option<&str>) {
        let providers = token
            .map(|token| json!({"muse":{"accessToken":token}}))
            .unwrap_or(json!({}));
        std::fs::write(
            &self.path,
            serde_json::to_vec(&json!({"version":1,"providers":providers})).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for ConfigFixture {
    fn drop(&mut self) {
        if let Some(original) = &self.original {
            std::fs::write(&self.path, original).unwrap();
        } else {
            std::fs::remove_file(&self.path).unwrap();
        }
    }
}
fn output(name: &str) -> PluginOutput {
    PluginOutput {
        provider_id: "muse".into(),
        display_name: name.into(),
        plan: None,
        lines: vec![],
        icon_url: String::new(),
    }
}
fn snapshot(name: &str) -> CachedPluginSnapshot {
    let mut snapshot = snapshot_from_output(&output(name), time::OffsetDateTime::now_utc());
    snapshot.config_fingerprint =
        Some(crate::provider_config::configuration_fingerprint("muse").unwrap());
    snapshot
}

#[test]
#[serial_test::serial]
fn changed_connection_filters_memory_disk_late_flush_and_limits() {
    let configuration = ConfigFixture::new();
    configuration.write(Some("dca:synthetic-account-a"));
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("settings.json"),
        r#"{"plugins":{"order":["muse"],"disabled":[]}}"#,
    )
    .unwrap();
    init(directory.path(), vec!["muse".into()], "test".into());
    let account_a = snapshot("Account A");
    let old_process = HashMap::from([("muse".into(), account_a.clone())]);
    account_projection::save_cache(directory.path(), &old_process).unwrap();
    {
        let mut state = cache_state().lock().unwrap();
        state.snapshots = old_process.clone();
        state.limit_catalog.insert(
            "muse".into(),
            ProviderLimitCatalog {
                provider_id: "muse".into(),
                resources: vec![],
            },
        );
    }
    assert!(snapshot_for_provider("muse").is_some());
    assert_eq!(
        load_cache(directory.path())["muse"].display_name,
        "Account A"
    );
    assert!(current_envelope(&["muse".into()])
        .providers
        .contains_key("muse"));

    configuration.write(Some("dca:synthetic-account-b"));
    assert!(snapshot_for_provider("muse").is_none());
    assert!(load_cache(directory.path()).is_empty());
    assert!(current_envelope(&["muse".into()]).providers.is_empty());
    assert!(super::super::enabled_snapshots_ordered(&cache_state().lock().unwrap()).is_empty());
    assert!(!super::super::health_cache_state().cache.ready);
    // A second process can still hold A in memory after B's settings were saved.
    account_projection::save_cache(directory.path(), &old_process).unwrap();
    assert!(load_cache(directory.path()).is_empty());

    let account_b = snapshot("Account B");
    let current = HashMap::from([("muse".into(), account_b.clone())]);
    account_projection::save_cache(directory.path(), &current).unwrap();
    account_projection::save_cache(directory.path(), &old_process).unwrap();
    account_projection::save_cache_with_forced_providers(
        directory.path(),
        &HashMap::new(),
        &HashMap::from([("muse".into(), Some(account_a))]),
    )
    .unwrap();
    assert_eq!(
        load_cache(directory.path())["muse"].display_name,
        "Account B"
    );
    assert!(cache_configured_output(
        &output("Account B"),
        time::OffsetDateTime::now_utc(),
        account_b.config_fingerprint.as_ref().unwrap()
    )
    .is_ok());
    assert_eq!(
        snapshot_for_provider("muse").unwrap().display_name,
        "Account B"
    );
    super::super::flush_cache().unwrap();
}

#[test]
#[serial_test::serial]
fn unscoped_legacy_configured_snapshots_are_rejected_even_without_configuration() {
    let configuration = ConfigFixture::new();
    configuration.write(None);
    let directory = tempfile::tempdir().unwrap();
    init(
        directory.path(),
        vec!["muse".into(), "cursor".into()],
        "test".into(),
    );
    let unscoped = snapshot_from_output(&output("Legacy Muse"), time::OffsetDateTime::now_utc());
    let mut original_provider = unscoped.clone();
    original_provider.provider_id = "cursor".into();
    let snapshots = HashMap::from([
        ("muse".into(), unscoped),
        ("cursor".into(), original_provider),
    ]);
    // Exercise old on-disk serde input directly, bypassing the new write filter.
    std::fs::write(
        directory.path().join("usage-api-cache.json"),
        serde_json::to_vec(&UsageApiCacheFile {
            version: 1,
            snapshots,
        })
        .unwrap(),
    )
    .unwrap();
    let loaded = load_cache(directory.path());
    assert!(!loaded.contains_key("muse"));
    assert!(loaded.contains_key("cursor"));
    super::super::cache_successful_output(
        &output("Unscoped Muse"),
        time::OffsetDateTime::now_utc(),
    );
    assert!(snapshot_for_provider("muse").is_none());
    assert!(cache_configured_output(
        &output("Wrong Source"),
        time::OffsetDateTime::now_utc(),
        "obsolete-fingerprint"
    )
    .is_err());
}

#[test]
#[serial_test::serial]
fn failed_configured_deletion_cannot_retry_over_another_process_new_account() {
    let configuration = ConfigFixture::new();
    configuration.write(Some("dca:synthetic-account-a"));
    let directory = tempfile::tempdir().unwrap();
    let blocked = directory.path().join("not-a-directory");
    std::fs::write(&blocked, "block cache creation").unwrap();
    init(
        &blocked,
        vec!["muse".into(), "cursor".into()],
        "test".into(),
    );
    cache_state()
        .lock()
        .unwrap()
        .snapshots
        .insert("muse".into(), snapshot("Account A"));
    assert!(account_projection::replace_account_projection("muse", None).is_err());
    assert!(!cache_state()
        .lock()
        .unwrap()
        .forced_projections
        .contains_key("muse"));
    // The established providers still keep their existing retry behavior.
    assert!(account_projection::replace_account_projection("cursor", None).is_err());
    assert!(cache_state()
        .lock()
        .unwrap()
        .forced_projections
        .contains_key("cursor"));

    configuration.write(Some("dca:synthetic-account-b"));
    let working = directory.path().join("working-cache");
    let current = HashMap::from([("muse".into(), snapshot("Account B"))]);
    account_projection::save_cache(&working, &current).unwrap();
    cache_state().lock().unwrap().app_data_dir = working.clone();
    super::super::flush_cache().unwrap();
    assert_eq!(load_cache(&working)["muse"].display_name, "Account B");
}
