use super::*;
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

pub(super) struct LegacyFixture(pub(super) Fixture);
impl LegacyFixture {
    pub(super) fn new() -> Self {
        legacy::TEST_CONFIGURATION.with(|value| *value.borrow_mut() = Some(HashMap::new()));
        legacy::TEST_ENV.with(|value| *value.borrow_mut() = Some((HashMap::new(), HashSet::new())));
        Self(Fixture::new())
    }
}
impl Drop for LegacyFixture {
    fn drop(&mut self) {
        legacy::TEST_CONFIGURATION.with(|value| *value.borrow_mut() = None);
        legacy::TEST_ENV.with(|value| *value.borrow_mut() = None);
        legacy::BEFORE_COMMIT.with(|value| *value.borrow_mut() = None);
        legacy::AFTER_CONFIGURATION.with(|value| *value.borrow_mut() = None);
    }
}

pub(super) fn set_configuration(source: &str, field: &str, value: &str) {
    legacy::TEST_CONFIGURATION.with(|values| {
        *values.borrow_mut() = Some(HashMap::from([
            ("source".into(), serde_json::json!(source)),
            (field.into(), serde_json::json!(value)),
        ]))
    });
}

pub(super) fn legacy_plugin() -> LoadedPlugin {
    let mut p = plugin(&"a".repeat(64), 24);
    p.manifest.config = Some(serde_json::from_value(serde_json::json!({"fields":[
        {"id":"source","type":"select","label":"Source","default":"cookie","options":[{"value":"cookie","label":"Cookie"},{"value":"apiKey","label":"API Key"}]},
        {"id":"cookieHeader","type":"secret","label":"Cookie","environmentVariables":["OLLAMA_CLOUD_COOKIE"]},
        {"id":"apiKey","type":"secret","label":"API Key","environmentVariables":["OLLAMA_API_KEY"]}
    ]})).unwrap());
    p.entry_script.push_str(r#"globalThis.__openusage_plugin={probe(ctx){
        const source=ctx.host.config.get('source');
        if(!ctx.host.config.get(source==='apiKey'?'apiKey':'cookieHeader'))throw 'missing captured configuration';
        return {plan:'Original',lines:[{type:'progress',label:'Monthly',used:11,limit:100,format:{kind:'dollars'}}]};
    }};"#);
    p
}

#[test]
#[serial_test::serial]
fn old_store_loads_unchanged_and_legacy_view_has_no_credentials_or_generations() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    let old = r#"{"version":1,"revision":5,"primary":{"mode":"none"},"connections":[]}"#;
    std::fs::write(&f.0.path, old).unwrap();
    assert_eq!(store::read().unwrap().legacy.revision, 0);
    assert_eq!(std::fs::read_to_string(&f.0.path).unwrap(), old);
    let providers = crate::provider_config::config_path().unwrap();
    let original = std::fs::read(&providers).ok();
    set_configuration("apiKey", "apiKey", "synthetic-original-key");
    legacy::refresh(
        &p,
        &f.0.dir(),
        "test",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let stored = store::read().unwrap();
    let view = stored.view();
    assert!(view.legacy.configured);
    assert_eq!(view.legacy.source, "apiKey");
    assert_eq!(view.primary, Primary::None);
    assert!(view.legacy.snapshot.is_some());
    for data in [
        serde_json::to_string(&view).unwrap(),
        std::fs::read_to_string(&f.0.path).unwrap(),
    ] {
        assert!(!data.contains("synthetic-original-key"));
    }
    let visible = serde_json::to_string(&view).unwrap();
    assert!(!visible.contains(stored.legacy.configuration_generation.as_ref().unwrap()));
    assert_eq!(std::fs::read(&providers).ok(), original);
}

#[test]
fn selected_source_uses_stored_then_environment_and_distinguishes_missing_from_unresolved() {
    let _f = LegacyFixture::new();
    let p = legacy_plugin();
    legacy::TEST_ENV.with(|value| {
        *value.borrow_mut() = Some((
            HashMap::from([
                ("OLLAMA_API_KEY".into(), Some("synthetic-env-key".into())),
                (
                    "OLLAMA_CLOUD_COOKIE".into(),
                    Some("synthetic-env-cookie".into()),
                ),
            ]),
            HashSet::new(),
        ))
    });
    set_configuration("apiKey", "apiKey", "synthetic-saved-key");
    let captured = legacy::configuration(&p);
    assert_eq!(captured.values["apiKey"], "synthetic-saved-key");
    assert!(!captured.values.contains_key("cookieHeader"));
    set_configuration("apiKey", "apiKey", "");
    let captured = legacy::configuration(&p);
    assert_eq!(captured.values["apiKey"], "synthetic-env-key");
    assert!(captured.configured);
    set_configuration("cookie", "cookieHeader", "");
    assert_eq!(
        legacy::configuration(&p).values["cookieHeader"],
        "synthetic-env-cookie"
    );
    legacy::TEST_ENV.with(|value| *value.borrow_mut() = Some((HashMap::new(), HashSet::new())));
    let missing = legacy::configuration(&p);
    assert!(!missing.configured && missing.error.is_none());
    legacy::TEST_ENV.with(|value| {
        *value.borrow_mut() = Some((
            HashMap::new(),
            HashSet::from(["OLLAMA_CLOUD_COOKIE".into()]),
        ))
    });
    let unavailable = legacy::configuration(&p);
    assert!(!unavailable.configured);
    assert_eq!(unavailable.error.unwrap().code, "configurationUnavailable");
}

#[test]
#[serial_test::serial]
fn legacy_nonprimary_refresh_and_config_change_never_replace_the_primary() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    super::projection::initialize_cache(&f.0);
    let view = add(&f.0, &p, "synthetic-managed-key", "Work", None, false);
    commands::perform(
        &p,
        &f.0.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: view.connections[0].connection_id.clone(),
        },
    )
    .unwrap();
    restore_primary_projection(&p).unwrap();
    let before = crate::local_http_api::cache::snapshot_for_provider("ollama").unwrap();
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    legacy::refresh(
        &p,
        &f.0.dir(),
        "test",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let first = store::read().unwrap();
    assert_eq!(
        first.legacy.snapshot.as_ref().unwrap().plan.as_deref(),
        Some("Original")
    );
    assert_eq!(
        crate::local_http_api::cache::snapshot_for_provider("ollama")
            .unwrap()
            .fetched_at,
        before.fetched_at
    );
    with_legacy_configuration_change(|| {
        set_configuration("apiKey", "apiKey", "synthetic-original-key");
        Ok(())
    })
    .unwrap();
    let changed = store::read().unwrap();
    assert!(changed.legacy.snapshot.is_none());
    assert!(changed.legacy.revision > first.legacy.revision);
    assert!(changed.connections[0].snapshot.is_some());
    assert_eq!(
        crate::local_http_api::cache::snapshot_for_provider("ollama")
            .unwrap()
            .plan,
        before.plan
    );
}

#[test]
#[serial_test::serial]
fn legacy_config_aba_rejects_late_result_and_retains_only_current_source_data() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    set_configuration("cookie", "cookieHeader", "synthetic-cookie-a");
    let mut stored = StoredAccounts::default();
    stored.primary = Primary::None;
    store::write_to(&f.0.path, &stored).unwrap();
    legacy::BEFORE_COMMIT.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|| {
            with_legacy_configuration_change(|| {
                set_configuration("cookie", "cookieHeader", "synthetic-cookie-b");
                Ok(())
            })
            .unwrap();
            with_legacy_configuration_change(|| {
                set_configuration("cookie", "cookieHeader", "synthetic-cookie-a");
                Ok(())
            })
            .unwrap();
        }))
    });
    assert!(
        legacy::refresh(
            &p,
            &f.0.dir(),
            "test",
            Instant::now() + Duration::from_secs(1)
        )
        .is_err()
    );
    assert!(store::read().unwrap().legacy.snapshot.is_none());
}

#[test]
#[serial_test::serial]
fn legacy_network_failure_preserves_timestamp_but_expired_auth_clears_only_legacy() {
    let f = LegacyFixture::new();
    let mut p = legacy_plugin();
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    legacy::refresh(
        &p,
        &f.0.dir(),
        "test",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let previous = store::read().unwrap().legacy;
    p.entry_script = "globalThis.__openusage_plugin={probe(){throw 'Network unavailable'}}".into();
    legacy::refresh(
        &p,
        &f.0.dir(),
        "test",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let failed = store::read().unwrap().legacy;
    assert!(failed.snapshot.is_some());
    assert_eq!(failed.last_updated_at, previous.last_updated_at);
    p.entry_script = "globalThis.__openusage_plugin={probe(){throw 'Ollama Cloud session expired. Sign in at ollama.com and copy a fresh Cookie header.'}}".into();
    legacy::refresh(
        &p,
        &f.0.dir(),
        "test",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let expired = store::read().unwrap().legacy;
    assert!(expired.snapshot.is_none() && expired.last_updated_at.is_none());
    assert_eq!(expired.error.unwrap().code, "authExpired");
}

#[test]
#[serial_test::serial]
fn explicit_legacy_report_ignores_primary_selection_but_rejects_source_change() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    set_configuration("apiKey", "apiKey", "synthetic-original-key");
    let view = add(&f.0, &p, "synthetic-managed-key", "Work", None, false);
    let captured = report_legacy_connection(&p).unwrap();
    assert!(!captured.uses_primary && captured.connection_id.is_none());
    assert_eq!(
        captured.configuration.as_ref().unwrap()["apiKey"],
        "synthetic-original-key"
    );
    commands::perform(
        &p,
        &f.0.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: view.connections[0].connection_id.clone(),
        },
    )
    .unwrap();
    assert!(report_connection_unchanged(&p, &captured).is_ok());
    with_legacy_configuration_change(|| {
        set_configuration("apiKey", "apiKey", "synthetic-replaced-original-key");
        Ok(())
    })
    .unwrap();
    assert!(report_connection_unchanged(&p, &captured).is_err());
}

#[test]
#[serial_test::serial]
fn default_legacy_report_stamp_uses_the_same_environment_snapshot_as_its_request() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    store::write_to(&f.0.path, &StoredAccounts::default()).unwrap();
    set_configuration("apiKey", "apiKey", "");
    legacy::TEST_ENV.with(|value| {
        *value.borrow_mut() = Some((
            HashMap::from([("OLLAMA_API_KEY".into(), Some("synthetic-env-a".into()))]),
            HashSet::new(),
        ))
    });
    legacy::AFTER_CONFIGURATION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|| {
            legacy::TEST_ENV.with(|value| {
                *value.borrow_mut() = Some((
                    HashMap::from([("OLLAMA_API_KEY".into(), Some("synthetic-env-b".into()))]),
                    HashSet::new(),
                ))
            });
        }))
    });
    let captured = report_connection(&p, None).unwrap();
    assert_eq!(
        captured.configuration.as_ref().unwrap()["apiKey"],
        "synthetic-env-a"
    );
    assert!(
        report_connection_unchanged(&p, &captured).is_err(),
        "an A request must not be accepted under a B stamp"
    );
}

#[test]
#[serial_test::serial]
fn startup_cached_reads_keep_current_legacy_timestamp_but_clear_a_changed_environment() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    super::projection::initialize_cache(&f.0);
    set_configuration("apiKey", "apiKey", "");
    legacy::TEST_ENV.with(|value| {
        *value.borrow_mut() = Some((
            HashMap::from([("OLLAMA_API_KEY".into(), Some("synthetic-env-a".into()))]),
            HashSet::new(),
        ))
    });
    legacy::refresh(
        &p,
        &f.0.dir(),
        "test",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let before = crate::local_http_api::cache::snapshot_for_provider("ollama").unwrap();
    restore_primary_projection(&p).unwrap();
    let unchanged = crate::local_http_api::cache::snapshot_for_provider("ollama").unwrap();
    assert_eq!(unchanged.fetched_at, before.fetched_at);
    assert_eq!(unchanged.started_at, before.started_at);
    legacy::TEST_ENV.with(|value| {
        *value.borrow_mut() = Some((
            HashMap::from([("OLLAMA_API_KEY".into(), Some("synthetic-env-b".into()))]),
            HashSet::new(),
        ))
    });
    restore_primary_projection(&p).unwrap();
    assert!(store::read().unwrap().legacy.snapshot.is_none());
    assert!(crate::local_http_api::cache::snapshot_for_provider("ollama").is_none());
    assert!(!crate::local_http_api::cache::load_cache(&f.0.dir()).contains_key("ollama"));
}

#[test]
#[serial_test::serial]
fn native_legacy_refresh_masks_its_result_without_resolving_configuration_again() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    fn count_next(counter: Arc<AtomicUsize>) {
        legacy::AFTER_CONFIGURATION.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                count_next(counter);
            }))
        });
    }
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    let mut stored = StoredAccounts::default();
    stored.primary = Primary::None;
    store::write_to(&f.0.path, &stored).unwrap();
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    let reads = Arc::new(AtomicUsize::new(0));
    count_next(reads.clone());
    let view = commands::perform_before(
        &p,
        &f.0.dir(),
        "test",
        Operation::RefreshLegacy,
        Instant::now() + Duration::from_secs(1),
        &|| {},
    )
    .unwrap();
    assert!(view.legacy.snapshot.is_some());
    assert_eq!(
        reads.load(Ordering::SeqCst),
        2,
        "only capture and pre-commit validation may resolve configuration"
    );
}
