use super::*;
use crate::plugin_engine::manifest::{LoadedPlugin, PluginManifest};
use model::{AccountError, DisplayIdentity, Record, StoredAccounts};

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ollama-accounts.json");
        store::TEST_PATH.with(|p| *p.borrow_mut() = Some(path.clone()));
        Self { _dir: dir, path }
    }
    fn dir(&self) -> PathBuf {
        self._dir.path().to_path_buf()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        store::TEST_PATH.with(|p| *p.borrow_mut() = None);
    }
}

fn plugin(identity: &str, used: u32) -> LoadedPlugin {
    let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
        "schemaVersion":1,"id":"ollama","name":"Ollama Cloud","version":"0.0.1","entry":"plugin.js","icon":"icon.svg","lines":[]
    })).unwrap();
    let script = format!(
        r#"globalThis.__openusage_ollama_account = ctx => {{
      if(ctx.host.config.get('source')!=='apiKey'||!ctx.host.config.get('apiKey'))throw 'missing isolated key';
      return {{identity:{{fingerprint:'{identity}',name:'Synthetic User',email:'synthetic@example.invalid'}},plan:'Test',
        lines:[{{type:'progress',label:'Monthly',used:{used},limit:100,format:{{kind:'dollars'}}}}]}};
    }};"#
    );
    LoadedPlugin {
        manifest,
        plugin_dir: PathBuf::from("."),
        entry_script: script,
        icon_data_url: "data:image/svg+xml;base64,".into(),
    }
}

fn record(id: &str, identity: &str) -> Record {
    Record {
        connection_id: id.into(),
        label: id.into(),
        identity: DisplayIdentity {
            name: Some("Synthetic User".into()),
            email: None,
        },
        identity_fingerprint: identity.into(),
        api_key: format!("synthetic-secret-{id}"),
        revision: 1,
        snapshot: None,
        last_updated_at: None,
        error: None,
    }
}

fn add(
    f: &Fixture,
    plugin: &LoadedPlugin,
    key: &str,
    label: &str,
    target: Option<String>,
    as_new: bool,
) -> AccountsView {
    let verification = commands::verify(plugin, &f.dir(), "test", key.into(), target).unwrap();
    commands::save(plugin, &verification.verification_id, label.into(), as_new).unwrap()
}

#[test]
#[serial_test::serial]
fn adding_keys_preserves_legacy_configuration_and_does_not_select_a_primary() {
    let f = Fixture::new();
    // Watch the actual synthetic provider-config path used by host injection,
    // rather than a nearby file that this code never consults.
    let legacy = crate::provider_config::config_path().unwrap();
    let original = std::fs::read(&legacy).ok();
    let view = add(
        &f,
        &plugin(&"a".repeat(64), 24),
        "synthetic-key-one",
        "Personal",
        None,
        false,
    );
    assert_eq!(view.primary, Primary::Legacy);
    let view = add(
        &f,
        &plugin(&"b".repeat(64), 68),
        "synthetic-key-two",
        "Work",
        None,
        false,
    );
    assert_eq!(view.connections.len(), 2);
    assert_eq!(view.primary, Primary::Legacy);
    assert_ne!(
        view.connections[0].connection_id,
        view.connections[1].connection_id
    );
    assert_eq!(std::fs::read(&legacy).ok(), original);
    let encoded = serde_json::to_string(&view).unwrap();
    assert!(!encoded.contains("synthetic-key-one"));
    assert!(!encoded.contains("apiKey"));
    assert!(!encoded.contains(&"a".repeat(64)));
    assert!(encoded.contains("one"));
}

#[test]
fn verification_failure_and_different_user_cannot_replace_an_existing_key() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let view = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = view.connections[0].connection_id.clone();
    let before = std::fs::read(&f.path).unwrap();
    let mut denied = p.clone();
    denied.entry_script = "globalThis.__openusage_ollama_account=()=>{throw JSON.stringify({code:'authExpired',message:'synthetic-secret-do-not-return'})}".into();
    let error = commands::verify(
        &denied,
        &f.dir(),
        "test",
        "synthetic-key-two".into(),
        Some(id.clone()),
    )
    .unwrap_err();
    assert!(!error.contains("synthetic-secret"));
    assert_eq!(std::fs::read(&f.path).unwrap(), before);
    let changed = plugin(&"b".repeat(64), 68);
    let token = commands::verify(
        &changed,
        &f.dir(),
        "test",
        "synthetic-key-two".into(),
        Some(id.clone()),
    )
    .unwrap();
    assert!(token.different_account);
    assert!(commands::save(&changed, &token.verification_id, "Work".into(), false).is_err());
    assert_eq!(std::fs::read(&f.path).unwrap(), before);
    let view = add(
        &f,
        &changed,
        "synthetic-key-two",
        "Work",
        Some(id.clone()),
        true,
    );
    assert_eq!(view.connections.len(), 2);
    assert_eq!(view.connections[0].connection_id, id);
    assert_eq!(
        store::read().unwrap().connections[0].api_key,
        "synthetic-key-one"
    );
}

#[test]
fn verified_replacement_is_single_use_and_cannot_overwrite_a_newer_credential() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    let older = commands::verify(
        &p,
        &f.dir(),
        "test",
        "synthetic-key-old".into(),
        Some(id.clone()),
    )
    .unwrap();
    let newer =
        commands::verify(&p, &f.dir(), "test", "synthetic-key-new".into(), Some(id)).unwrap();
    let saved = commands::save(&p, &newer.verification_id, "Renamed".into(), false).unwrap();
    assert_eq!(saved.connections.len(), 1);
    assert_eq!(saved.connections[0].revision, 2);
    assert!(commands::save(&p, &older.verification_id, "Old".into(), false).is_err());
    assert!(commands::save(&p, &newer.verification_id, "Again".into(), false).is_err());
    assert_eq!(
        store::read().unwrap().connections[0].api_key,
        "synthetic-key-new"
    );
}

#[test]
fn same_identity_keys_are_marked_but_remain_independent_connections() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let token = commands::verify(&p, &f.dir(), "test", "synthetic-key-two".into(), None).unwrap();
    assert!(token.same_account);
    let saved = commands::save(&p, &token.verification_id, "Second Key".into(), false).unwrap();
    assert_eq!(saved.connections.len(), 2);
    assert_ne!(
        saved.connections[0].connection_id,
        saved.connections[1].connection_id
    );
}

#[test]
#[serial_test::serial]
fn selection_aba_invalidates_projection_and_removal_never_falls_back() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let view = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let a = view.connections[0].connection_id.clone();
    let view = add(
        &f,
        &plugin(&"b".repeat(64), 68),
        "synthetic-key-two",
        "Work",
        None,
        false,
    );
    let b = view.connections[1].connection_id.clone();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: a.clone(),
        },
    )
    .unwrap();
    let original = projection_generation(&p).unwrap();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary { connection_id: b },
    )
    .unwrap();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: a.clone(),
        },
    )
    .unwrap();
    assert_ne!(projection_generation(&p).unwrap(), original);
    assert!(
        with_projection_guard(&p, Some(&original), || panic!(
            "old projection must not publish"
        ))
        .is_err()
    );
    let view =
        commands::perform(&p, &f.dir(), "test", Operation::Remove { connection_id: a }).unwrap();
    assert_eq!(view.primary, Primary::None);
    assert!(!uses_legacy_primary().unwrap());
    let view = add(&f, &p, "synthetic-key-three", "Third", None, false);
    assert_eq!(view.primary, Primary::None);
}

#[test]
fn transient_error_preserves_snapshot_but_identity_mismatch_suppresses_it() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let mut r = record("one", &"a".repeat(64));
    let good = runtime::probe(&p, &f.dir(), "test", &r.api_key).unwrap();
    store::apply_probe(&mut r, Ok(good), &p);
    let before = serde_json::to_string(&r.snapshot).unwrap();
    let timestamp = r.last_updated_at.clone();
    store::apply_probe(
        &mut r,
        Err(AccountError {
            code: "rateLimited".into(),
            message: "Try later".into(),
        }),
        &p,
    );
    assert_eq!(serde_json::to_string(&r.snapshot).unwrap(), before);
    assert_eq!(r.last_updated_at, timestamp);
    let changed =
        runtime::probe(&plugin(&"b".repeat(64), 68), &f.dir(), "test", &r.api_key).unwrap();
    store::apply_probe(&mut r, Ok(changed), &p);
    assert!(r.snapshot.is_none());
    assert!(r.last_updated_at.is_none());
    assert_eq!(r.error.unwrap().code, "identityChanged");
}

#[test]
#[serial_test::serial]
fn reports_bind_exact_connection_and_revision_without_changing_primary() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let view = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let a = view.connections[0].connection_id.clone();
    let view = add(&f, &p, "synthetic-key-two", "Work", None, false);
    let b = view.connections[1].connection_id.clone();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: a.clone(),
        },
    )
    .unwrap();
    let explicit = report_connection(
        &p,
        Some(&b),
        std::time::Instant::now() + std::time::Duration::from_secs(1),
    )
    .unwrap();
    let primary = report_connection(
        &p,
        None,
        std::time::Instant::now() + std::time::Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(
        explicit.configuration.as_ref().unwrap()["apiKey"],
        "synthetic-key-two"
    );
    assert_ne!(explicit.stamp, primary.stamp);
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: b.clone(),
        },
    )
    .unwrap();
    assert!(
        report_connection_unchanged(
            &p,
            &primary,
            std::time::Instant::now() + std::time::Duration::from_secs(1)
        )
        .is_err()
    );
    assert!(
        report_connection_unchanged(
            &p,
            &explicit,
            std::time::Instant::now() + std::time::Duration::from_secs(1)
        )
        .is_ok()
    );
    add(&f, &p, "synthetic-new-key", "Work", Some(b), false);
    assert!(
        report_connection_unchanged(
            &p,
            &explicit,
            std::time::Instant::now() + std::time::Duration::from_secs(1)
        )
        .is_err()
    );
}

#[test]
fn damaged_or_unknown_storage_is_preserved_and_never_falls_back() {
    let f = Fixture::new();
    for content in [
        "{broken",
        "{\"version\":99,\"revision\":0,\"primary\":{\"mode\":\"legacy\"},\"connections\":[]}",
    ] {
        std::fs::write(&f.path, content).unwrap();
        assert!(store::read().is_err());
        assert!(uses_legacy_primary().is_err());
        assert_eq!(std::fs::read_to_string(&f.path).unwrap(), content);
    }
}

#[test]
fn private_storage_and_view_never_expose_full_short_keys_or_raw_ids() {
    let f = Fixture::new();
    let mut stored = StoredAccounts::default();
    let mut r = record("one", &"a".repeat(64));
    r.api_key = "short".into();
    stored.connections.push(r);
    store::write_to(&f.path, &stored).unwrap();
    let view = serde_json::to_string(&stored.view()).unwrap();
    assert!(!view.contains("short"));
    assert!(!view.contains(&"a".repeat(64)));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&f.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(store::validate_key("bad\nkey").is_err());
    assert!(store::validate_label("\n").is_err());
}

#[test]
fn loading_saved_connections_registers_all_keys_for_log_redaction() {
    let f = Fixture::new();
    let mut stored = StoredAccounts::default();
    stored
        .connections
        .push(record("newly-loaded-private-marker", &"a".repeat(64)));
    let secret = stored.connections[0].api_key.clone();
    store::write_to(&f.path, &stored).unwrap();
    store::read().unwrap();
    let logged =
        crate::plugin_engine::host_api::redact_log_message(&format!("unexpected error {secret}"));
    assert!(!logged.contains(&secret));
}

#[test]
fn expired_verification_and_removed_target_never_recreate_a_connection() {
    let f = Fixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let token = commands::verify(&p, &f.dir(), "test", "synthetic-key-one".into(), None).unwrap();
    {
        let mut guard = store::lock().unwrap();
        guard
            .pending
            .get_mut(&token.verification_id)
            .unwrap()
            .created = std::time::Instant::now() - std::time::Duration::from_secs(301);
    }
    assert!(commands::save(&p, &token.verification_id, "Expired".into(), false).is_err());
    assert!(!f.path.exists());
    let first = add(&f, &p, "synthetic-key-one", "Personal", None, false);
    let id = first.connections[0].connection_id.clone();
    let token = commands::verify(
        &p,
        &f.dir(),
        "test",
        "synthetic-key-two".into(),
        Some(id.clone()),
    )
    .unwrap();
    commands::perform(
        &p,
        &f.dir(),
        "test",
        Operation::Remove { connection_id: id },
    )
    .unwrap();
    assert!(commands::save(&p, &token.verification_id, "Stale".into(), true).is_err());
    assert!(store::read().unwrap().connections.is_empty());
}

#[test]
fn waiting_for_same_connection_is_bounded_by_the_refresh_deadline() {
    let _f = Fixture::new();
    let _held = store::acquire_refresh(
        "same",
        std::time::Instant::now() + std::time::Duration::from_secs(1),
    )
    .unwrap();
    let start = std::time::Instant::now();
    assert!(store::acquire_refresh("same", start + std::time::Duration::from_millis(20)).is_err());
    assert!(start.elapsed() < std::time::Duration::from_millis(500));
}

#[path = "concurrency_tests.rs"]
mod concurrency;

#[path = "projection_tests.rs"]
mod projection;

#[path = "queued_probe_tests.rs"]
mod queued_probe;

#[path = "panic_probe_tests.rs"]
mod panic_probe;

#[path = "legacy_tests.rs"]
mod legacy_usage;

#[path = "batch_tests.rs"]
mod batch_usage;

#[path = "deadline_tests.rs"]
mod deadlines;
