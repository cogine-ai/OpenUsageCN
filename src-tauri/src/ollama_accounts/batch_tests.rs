use super::legacy_usage::{LegacyFixture, legacy_plugin, set_configuration};
use super::*;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

fn marked_plugin(f: &Fixture) -> LoadedPlugin {
    let mut p = legacy_plugin();
    let path = serde_json::to_string(&f.dir().to_string_lossy()).unwrap();
    p.entry_script = format!(
        r#"
        const root={path};
        globalThis.__openusage_ollama_account=ctx=>{{
          const key=ctx.host.config.get('apiKey'), work=key.includes('work');
          const marker=root+'/'+(work?'work':'personal')+'.txt';
          ctx.host.fs.writeText(marker, (ctx.host.fs.exists(marker)?ctx.host.fs.readText(marker):'')+'call\n');
          return {{identity:{{fingerprint:(work?'b':'a').repeat(64),name:work?'Work':'Personal'}},plan:work?'Work':'Personal',lines:[{{type:'progress',label:'Monthly',used:work?62:21,limit:100,format:{{kind:'dollars'}}}}]}};
        }};
        globalThis.__openusage_plugin={{probe(ctx){{
          const marker=root+'/original.txt';
          ctx.host.fs.writeText(marker,(ctx.host.fs.exists(marker)?ctx.host.fs.readText(marker):'')+'call\n');
          if(ctx.host.config.get('cookieHeader')!=='synthetic-cookie')throw 'wrong original configuration';
          return {{plan:'Original',lines:[{{type:'progress',label:'Monthly',used:11,limit:100,format:{{kind:'dollars'}}}}]}};
        }}}};"#
    );
    p
}

fn populate(f: &Fixture) {
    let mut stored = StoredAccounts::default();
    stored.primary = Primary::None;
    stored.connections = vec![
        record("personal", &"a".repeat(64)),
        record("work", &"b".repeat(64)),
    ];
    store::write_to(&f.path, &stored).unwrap();
}

#[test]
#[serial_test::serial]
fn gui_batch_updates_every_row_without_a_primary_and_emits_completed_rows() {
    let f = LegacyFixture::new();
    let p = marked_plugin(&f.0);
    populate(&f.0);
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    let events = AtomicUsize::new(0);
    let (output, stamp) = run_gui_probe(&p, &f.0.dir(), "test", || {
        events.fetch_add(1, Ordering::SeqCst);
    });
    assert!(stamp.is_some());
    assert!(crate::plugin_engine::runtime::probe_error_message(&output).is_some());
    let stored = store::read().unwrap();
    assert_eq!(stored.primary, Primary::None);
    assert!(
        stored
            .connections
            .iter()
            .all(|r| r.snapshot.is_some() && r.error.is_none() && r.last_updated_at.is_some())
    );
    assert!(stored.legacy.snapshot.is_some());
    assert!(events.load(Ordering::SeqCst) >= 3);
    for target in ["personal", "work", "original"] {
        assert_eq!(
            std::fs::read_to_string(f.0.dir().join(format!("{target}.txt"))).unwrap(),
            "call\n"
        );
    }
}

#[test]
#[serial_test::serial]
fn primary_is_requested_once_and_sibling_failure_cannot_replace_its_projection() {
    let f = LegacyFixture::new();
    let mut p = marked_plugin(&f.0);
    populate(&f.0);
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    super::projection::initialize_cache(&f.0);
    commands::perform(
        &p,
        &f.0.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: "personal".into(),
        },
    )
    .unwrap();
    p.entry_script.push_str(r#"const originalAccount=globalThis.__openusage_ollama_account;
      globalThis.__openusage_ollama_account=ctx=>{if(ctx.host.config.get('apiKey').includes('work'))throw JSON.stringify({code:'rateLimited',message:'Try later'});return originalAccount(ctx)};"#);
    let (output, _) = run_gui_probe(&p, &f.0.dir(), "test", || {});
    assert_eq!(output.plan.as_deref(), Some("Personal"));
    let stored = store::read().unwrap();
    assert_eq!(
        stored.connections[1].error.as_ref().unwrap().code,
        "rateLimited"
    );
    assert_eq!(
        crate::local_http_api::cache::snapshot_for_provider("ollama")
            .unwrap()
            .plan
            .as_deref(),
        Some("Personal")
    );
    assert_eq!(
        std::fs::read_to_string(f.0.dir().join("personal.txt")).unwrap(),
        "call\n"
    );
    assert!(stored.legacy.snapshot.is_some());
}

#[test]
#[serial_test::serial]
fn cli_refresh_keeps_primary_only_while_gui_all_can_include_legacy() {
    let f = LegacyFixture::new();
    let p = marked_plugin(&f.0);
    populate(&f.0);
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    commands::perform(
        &p,
        &f.0.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: "personal".into(),
        },
    )
    .unwrap();
    projection_generation(&p).unwrap();
    assert_eq!(
        run_primary_probe(&p, &f.0.dir(), "test").plan.as_deref(),
        Some("Personal")
    );
    assert!(!f.0.dir().join("work.txt").exists());
    assert!(!f.0.dir().join("original.txt").exists());
    assert!(store::read().unwrap().legacy.snapshot.is_none());
}

#[test]
#[serial_test::serial]
fn slow_account_does_not_starve_sibling_and_total_deadline_records_unfinished_row() {
    let f = LegacyFixture::new();
    let mut p = plugin(&"b".repeat(64), 24);
    let mut stored = StoredAccounts::default();
    stored.primary = Primary::None;
    stored.connections = vec![
        record("slow", &"a".repeat(64)),
        record("fast", &"b".repeat(64)),
    ];
    store::write_to(&f.0.path, &stored).unwrap();
    p.entry_script.push_str(r#"const good=globalThis.__openusage_ollama_account;
      globalThis.__openusage_ollama_account=ctx=>{if(ctx.host.config.get('apiKey').includes('slow')){while(true){}}return good(ctx)};"#);
    let started = Instant::now();
    batch::refresh_all(
        &p,
        &f.0.dir(),
        "test",
        &stored,
        started + Duration::from_millis(700),
        &|| {},
    )
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    let current = store::read().unwrap();
    assert!(current.connections[1].snapshot.is_some());
    assert!(current.connections[0].error.is_some());
}

#[test]
#[serial_test::serial]
fn expired_named_credential_clears_only_its_previous_snapshot() {
    let f = LegacyFixture::new();
    let p = plugin(&"a".repeat(64), 24);
    let mut stored = StoredAccounts::default();
    stored.primary = Primary::None;
    let mut first = record("first", &"a".repeat(64));
    let result = runtime::probe(&p, &f.0.dir(), "test", &first.api_key);
    store::apply_probe(&mut first, result, &p);
    let mut second = first.clone();
    second.connection_id = "second".into();
    stored.connections = vec![first, second];
    store::write_to(&f.0.path, &stored).unwrap();
    let mut expired = p.clone();
    expired.entry_script="globalThis.__openusage_ollama_account=()=>{throw JSON.stringify({code:'authExpired',message:'Expired'})}".into();
    refresh(
        &expired,
        &f.0.dir(),
        "test",
        "first",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let current = store::read().unwrap();
    assert!(current.connections[0].snapshot.is_none());
    assert!(current.connections[0].last_updated_at.is_none());
    assert!(current.connections[1].snapshot.is_some());
}
