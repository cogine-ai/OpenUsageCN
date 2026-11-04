use super::*;
use std::{sync::mpsc, time::Duration};

fn queued_probe_rejects_mutation(replacing: bool) {
    let fixture = Fixture::new();
    let plugin = plugin(&"a".repeat(64), 24);
    let initial = add(
        &fixture,
        &plugin,
        "synthetic-key-old",
        "Personal",
        None,
        false,
    );
    let id = initial.connections[0].connection_id.clone();
    commands::perform(
        &plugin,
        &fixture.dir(),
        "test",
        Operation::SelectPrimary {
            connection_id: id.clone(),
        },
    )
    .unwrap();
    let replacement = replacing.then(|| {
        commands::verify(
            &plugin,
            &fixture.dir(),
            "test",
            "synthetic-key-new".into(),
            Some(id.clone()),
        )
        .unwrap()
    });

    let marker = fixture.dir().join("queued-probe-used-key.txt");
    let mut queued_plugin = plugin.clone();
    queued_plugin.entry_script.push_str(&format!(
        r#"const accountProbe = globalThis.__openusage_ollama_account;
        globalThis.__openusage_ollama_account = ctx => {{
            ctx.host.fs.writeText({}, ctx.host.config.get('apiKey'));
            return accountProbe(ctx);
        }};"#,
        serde_json::to_string(&marker.to_string_lossy()).unwrap()
    ));

    // A CLI refresh can hold this same connection lock while the GUI captures its old key.
    let held_refresh =
        store::acquire_refresh(&id, std::time::Instant::now() + Duration::from_secs(2)).unwrap();
    let path = fixture.path.clone();
    let directory = fixture.dir();
    let (prepared_tx, prepared_rx) = mpsc::channel();
    let (continue_tx, continue_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        store::TEST_PATH.with(|value| *value.borrow_mut() = Some(path));
        PRIMARY_PROBE_PREPARED.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                prepared_tx.send(()).unwrap();
                continue_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            }));
        });
        let output = run_primary_probe(&queued_plugin, &directory, "test");
        store::TEST_PATH.with(|value| *value.borrow_mut() = None);
        output
    });
    prepared_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    continue_tx.send(()).unwrap();

    if let Some(replacement) = replacement {
        commands::save(
            &plugin,
            &replacement.verification_id,
            "Personal".into(),
            false,
        )
        .unwrap();
    } else {
        commands::perform(
            &plugin,
            &fixture.dir(),
            "test",
            Operation::Remove { connection_id: id },
        )
        .unwrap();
    }
    let after_mutation = std::fs::read(&fixture.path).unwrap();
    drop(held_refresh);
    let output = worker.join().unwrap();

    assert!(crate::plugin_engine::runtime::probe_error_message(&output).is_some());
    assert!(
        !marker.exists(),
        "queued refresh must not invoke a removed or replaced key"
    );
    assert_eq!(std::fs::read(&fixture.path).unwrap(), after_mutation);
    let current = store::read().unwrap();
    if replacing {
        assert_eq!(current.connections[0].api_key, "synthetic-key-new");
        assert_eq!(current.connections[0].revision, 2);
    } else {
        assert!(current.connections.is_empty());
        assert_eq!(current.primary, Primary::None);
    }
}

#[test]
#[serial_test::serial]
fn queued_primary_probe_does_not_use_a_removed_key() {
    queued_probe_rejects_mutation(false);
}

#[test]
#[serial_test::serial]
fn queued_primary_probe_does_not_use_a_replaced_key() {
    queued_probe_rejects_mutation(true);
}
