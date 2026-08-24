use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Duration;

use super::*;

fn key(account_id: &str) -> HistoryJobKey {
    HistoryJobKey {
        provider_id: "cursor".to_string(),
        account_id: account_id.to_string(),
        from_ms: 1_700_000_000_000,
        to_ms: 1_700_086_400_000,
        time_zone: "Asia/Taipei".to_string(),
        credential_generation: "generation-3".to_string(),
    }
}

#[test]
fn newer_same_key_job_cancels_and_supersedes_the_running_job() {
    let scheduler = HistoryScheduler::isolated_for_test();
    let (started_tx, started_rx) = mpsc::channel();
    let first = scheduler
        .schedule(key("account-a"), move |cancel| {
            started_tx.send(()).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_millis(250);
            while !cancel.is_cancelled() && std::time::Instant::now() < deadline {
                std::thread::yield_now();
            }
            if cancel.is_cancelled() {
                Err(HistoryError::Cancelled)
            } else {
                Ok(1_u8)
            }
        })
        .expect("first job schedules");
    started_rx.recv().expect("first job started");

    let second = scheduler
        .schedule(key("account-a"), |_cancel| Ok(2_u8))
        .expect("replacement schedules");

    assert!(matches!(first.wait(), Err(HistoryError::Cancelled)));
    assert_eq!(second.wait(), Ok(2));
}

#[test]
fn a_newer_window_supersedes_the_same_account_scope() {
    let scheduler = HistoryScheduler::isolated_for_test();
    let (started_tx, started_rx) = mpsc::channel();
    let first = scheduler
        .schedule(key("account-a"), move |cancel| {
            started_tx.send(()).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_millis(250);
            while !cancel.is_cancelled() && std::time::Instant::now() < deadline {
                std::thread::yield_now();
            }
            if cancel.is_cancelled() {
                Err(HistoryError::Cancelled)
            } else {
                Ok(1_u8)
            }
        })
        .expect("first window schedules");
    started_rx.recv().expect("first window started");
    let mut next_window = key("account-a");
    next_window.to_ms += 1_000;

    let second = scheduler
        .schedule(next_window, |_cancel| Ok(2_u8))
        .expect("newer window schedules");

    assert!(matches!(first.wait(), Err(HistoryError::Cancelled)));
    assert_eq!(second.wait(), Ok(2));
}

#[test]
fn no_more_than_two_history_jobs_run_globally() {
    let schedulers = [HistoryScheduler::global(), HistoryScheduler::global()];
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let (started_tx, started_rx) = mpsc::channel();
    let mut jobs = Vec::new();

    for (index, account) in ["one", "two", "three", "four"].into_iter().enumerate() {
        let gate = Arc::clone(&gate);
        let active = Arc::clone(&active);
        let maximum = Arc::clone(&maximum);
        let started_tx = started_tx.clone();
        jobs.push(
            schedulers[index % schedulers.len()]
                .schedule(key(account), move |_cancel| {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    let (lock, changed) = &*gate;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = changed.wait(released).unwrap();
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .expect("job schedules"),
        );
    }
    drop(started_tx);

    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first job starts");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second job starts");
    assert!(started_rx.recv_timeout(Duration::from_millis(50)).is_err());

    let (lock, changed) = &*gate;
    *lock.lock().unwrap() = true;
    changed.notify_all();
    for job in jobs {
        job.wait().expect("job completes");
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
}
