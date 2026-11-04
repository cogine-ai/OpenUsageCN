use super::legacy_usage::{LegacyFixture, legacy_plugin, set_configuration};
use super::*;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

#[test]
#[serial_test::serial]
fn legacy_queued_before_configuration_change_never_requests_the_old_credential() {
    let f = LegacyFixture::new();
    let mut p = legacy_plugin();
    set_configuration("cookie", "cookieHeader", "synthetic-cookie-old");
    legacy::synchronize(&p, Instant::now() + Duration::from_secs(1)).unwrap();
    let marker = f.0.dir().join("old-cookie-used.txt");
    p.entry_script = format!(
        "globalThis.__openusage_plugin={{probe(ctx){{ctx.host.fs.writeText({},'requested');return {{lines:[]}};}}}}",
        serde_json::to_string(&marker.to_string_lossy()).unwrap()
    );
    let held = store::acquire_refresh(
        "original-connection",
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    let path = f.0.path.clone();
    let directory = f.0.dir();
    let captured_config = legacy::TEST_CONFIGURATION.with(|value| value.borrow().clone());
    let (ready_tx, ready_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        store::TEST_PATH.with(|value| *value.borrow_mut() = Some(path));
        legacy::TEST_CONFIGURATION.with(|value| *value.borrow_mut() = captured_config);
        legacy::BEFORE_LOCK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                ready_tx.send(()).unwrap();
                resume_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            }))
        });
        legacy::refresh(
            &p,
            &directory,
            "test",
            Instant::now() + Duration::from_secs(2),
        )
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    with_legacy_configuration_change(|| {
        set_configuration("cookie", "cookieHeader", "synthetic-cookie-new");
        Ok(())
    })
    .unwrap();
    let after = std::fs::read(&f.0.path).unwrap();
    drop(held);
    resume_tx.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(!marker.exists());
    assert_eq!(std::fs::read(&f.0.path).unwrap(), after);
}

#[test]
#[serial_test::serial]
fn legacy_cache_file_contention_obeys_the_same_refresh_deadline() {
    let f = LegacyFixture::new();
    let p = legacy_plugin();
    set_configuration("cookie", "cookieHeader", "synthetic-cookie");
    super::projection::initialize_cache(&f.0);
    store::write_to(&f.0.path, &StoredAccounts::default()).unwrap();
    let before = std::fs::read(&f.0.path).unwrap();
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(f.0.dir().join(".usage-api-cache.lock"))
        .unwrap();
    file.lock().unwrap();
    let started = Instant::now();
    let result = legacy::refresh(&p, &f.0.dir(), "test", started + Duration::from_millis(25));
    file.unlock().unwrap();
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(std::fs::read(&f.0.path).unwrap(), before);
}

#[test]
fn account_store_mutex_contention_obeys_the_refresh_deadline() {
    let f = Fixture::new();
    let path = f.path.clone();
    let held = store::lock().unwrap();
    let worker = std::thread::spawn(move || {
        store::TEST_PATH.with(|value| *value.borrow_mut() = Some(path));
        let start = Instant::now();
        let failed = store::lock_until(start + Duration::from_millis(25)).is_err();
        (failed, start.elapsed())
    });
    let (failed, elapsed) = worker.join().unwrap();
    drop(held);
    assert!(failed);
    assert!(elapsed < Duration::from_millis(500));
}
