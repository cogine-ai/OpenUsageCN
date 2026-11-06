//! Bounded Keychain subprocesses. Preflight never reads secrets or changes ACLs.
use super::host_api::ProbeDeadline;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    process::Command,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
#[cfg(target_os = "macos")]
#[path = "keychain_preflight.rs"]
mod preflight;
type ReadResult = Result<String, String>;
#[derive(Default)]
struct Flight {
    result: Mutex<Option<ReadResult>>,
    changed: Condvar,
}
impl Drop for Flight {
    fn drop(&mut self) {
        let result = self
            .result
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(Ok(value)) = result {
            unsafe {
                value.as_bytes_mut().fill(0);
            }
        }
    }
}
type Key = (String, Option<String>);
fn flights() -> &'static Mutex<HashMap<Key, Weak<Flight>>> {
    static STATE: OnceLock<Mutex<HashMap<Key, Weak<Flight>>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn timeout() -> String {
    "timedOut: Keychain request exceeded its time limit.".into()
}
fn remaining(deadline: ProbeDeadline) -> Result<Duration, String> {
    deadline
        .clamp_duration(Duration::from_secs(10))
        .ok_or_else(timeout)
}
fn preflight(service: &str, account: Option<&str>, writing: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        preflight::check(service, account, writing)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, account, writing);
        Err("failed: Keychain API is only supported on macOS.".into())
    }
}
pub(crate) fn read_password(
    service: &str,
    account: Option<&str>,
    deadline: ProbeDeadline,
) -> ReadResult {
    let service = service.to_owned();
    let account = account.map(str::to_owned);
    let key = (service.clone(), account.clone());
    let deadline = ProbeDeadline::at(Instant::now() + remaining(deadline)?);
    read_with(&key.clone(), deadline, move || {
        preflight(&service, account.as_deref(), false)?;
        if denied()
            .lock()
            .map_err(|_| "failed: Keychain state unavailable.")?
            .contains(&key)
        {
            return Err("denied: Keychain access was denied. Restart after restoring access in Keychain Access.".into());
        }
        let mut args = vec!["find-generic-password".into(), "-s".into(), service.into()];
        if let Some(account) = account {
            args.extend(["-a".into(), account.into()]);
        }
        args.push("-w".into());
        let result = run_security(&args, deadline);
        if result
            .as_ref()
            .is_err_and(|error| error.starts_with("denied:"))
        {
            denied()
                .lock()
                .map_err(|_| "failed: Keychain state unavailable.")?
                .insert(key);
        }
        result
    })
}
fn denied() -> &'static Mutex<HashSet<Key>> {
    static STATE: OnceLock<Mutex<HashSet<Key>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn read_with(
    key: &Key,
    deadline: ProbeDeadline,
    work: impl FnOnce() -> ReadResult + Send + 'static,
) -> ReadResult {
    let (flight, leader) = {
        let mut flights = flights()
            .lock()
            .map_err(|_| "failed: Keychain state is unavailable.")?;
        flights.retain(|_, value| value.strong_count() > 0);
        let key = key.clone();
        match flights.get(&key).and_then(Weak::upgrade) {
            Some(flight) => (flight, false),
            None => {
                let flight = Arc::new(Flight::default());
                flights.insert(key, Arc::downgrade(&flight));
                (flight, true)
            }
        }
    };
    remaining(deadline)?;
    if leader {
        let flight_worker = flight.clone();
        std::thread::spawn(move || {
            let result = work();
            *flight_worker.result.lock().unwrap() = Some(result);
            flight_worker.changed.notify_all();
        });
    }
    let mut result = flight
        .result
        .lock()
        .map_err(|_| "failed: Keychain state is unavailable.")?;
    while result.is_none() {
        let (guard, wait) = flight
            .changed
            .wait_timeout(result, remaining(deadline)?)
            .map_err(|_| "failed: Keychain state is unavailable.")?;
        result = guard;
        if wait.timed_out() && result.is_none() {
            return Err(timeout());
        }
    }
    result.as_ref().unwrap().clone()
}
pub(super) fn write_password(
    service: &str,
    account: Option<&str>,
    value: &str,
    deadline: ProbeDeadline,
) -> Result<(), String> {
    let deadline = ProbeDeadline::at(Instant::now() + remaining(deadline)?);
    let service = service.to_owned();
    let account = account.map(str::to_owned);
    let mut value = value.to_owned();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            preflight(&service, account.as_deref(), true)?;
            let key = (service.clone(), account.clone());
            if denied()
                .lock()
                .map_err(|_| "failed: Keychain state unavailable.")?
                .contains(&key)
            {
                return Err(
                    "denied: Keychain access was denied. Restart after restoring access.".into(),
                );
            }
            // Preserve the account selected by service-only reads, rather than creating a new item.
            let account = match account {
                Some(account) => account,
                None => {
                    let metadata = run_security(
                        &[
                            "find-generic-password".into(),
                            "-s".into(),
                            service.clone().into(),
                        ],
                        deadline,
                    )?;
                    metadata
                        .lines()
                        .find_map(|line| {
                            line.split_once("\"acct\"<blob>=\"").and_then(|(_, tail)| {
                                tail.split_once('"').map(|(account, _)| account.to_owned())
                            })
                        })
                        .ok_or("failed: Keychain item account could not be identified.")?
                }
            };
            let args = vec![
                "add-generic-password".into(),
                "-U".into(),
                "-s".into(),
                service.into(),
                "-a".into(),
                account.into(),
                "-w".into(),
                value.clone().into(),
            ];
            let result = run_security(&args, deadline).map(|_| ());
            if result
                .as_ref()
                .is_err_and(|error| error.starts_with("denied:"))
            {
                denied()
                    .lock()
                    .map_err(|_| "failed: Keychain state unavailable.")?
                    .insert(key);
            }
            result
        })();
        unsafe {
            value.as_bytes_mut().fill(0);
        }
        let _ = sender.send(result);
    });
    receiver
        .recv_timeout(remaining(deadline)?)
        .map_err(|_| timeout())?
}
fn classify(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if text.contains("could not be found") || text.contains("errsecitemnotfound") {
        "missing: Keychain item was not found.".into()
    } else if text.contains("interaction is not allowed") || text.contains("locked") {
        "locked: Unlock your login Keychain and retry.".into()
    } else if text.contains("canceled")
        || text.contains("cancelled")
        || text.contains("authorization denied")
        || text.contains("auth failed")
        || text.contains("authorization was denied")
    {
        "denied: Keychain access was denied.".into()
    } else {
        "failed: Keychain operation failed.".into()
    }
}
fn run_security(args: &[OsString], deadline: ProbeDeadline) -> ReadResult {
    run_command("/usr/bin/security", args, remaining(deadline)?)
}
fn run_command(program: &str, args: &[OsString], budget: Duration) -> ReadResult {
    let output = crate::bounded_process::run(Command::new(program).args(args), None, Instant::now() + budget, 65536)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut => timeout(),
            std::io::ErrorKind::InvalidData => "failed: Keychain output exceeded its limit.".into(),
            _ => "failed: Keychain process could not complete.".into(),
        })?;
    let mut stdout = output.stdout;
    let result = if output.status.success() {
        match String::from_utf8(std::mem::take(&mut stdout)) {
            Ok(mut value) => { if value.ends_with('\n') { value.pop(); } Ok(value) }
            Err(error) => { let mut bytes = error.into_bytes(); bytes.fill(0); Err("failed: Keychain value is not UTF-8.".into()) }
        }
    } else { Err(classify(&output.stderr)) };
    stdout.fill(0);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failures_remain_distinct_and_never_echo_stderr() {
        for (message, prefix) in [
            ("The specified item could not be found", "missing:"),
            ("User interaction is not allowed", "locked:"),
            ("User canceled the operation", "denied:"),
            ("secret unknown error", "failed:"),
        ] {
            let error = classify(message.as_bytes());
            assert!(error.starts_with(prefix));
            assert!(!error.contains("secret"));
        }
    }
    #[test]
    fn concurrent_item_reads_share_one_operation() {
        let key = ("synthetic-singleflight".to_owned(), None);
        let deadline = ProbeDeadline::at(Instant::now() + Duration::from_secs(2));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let leader_key = key.clone();
        let leader = std::thread::spawn(move || {
            read_with(&leader_key, deadline, move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok("synthetic".into())
            })
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let active = flights()
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .upgrade()
            .unwrap();
        let follower_key = key.clone();
        let follower = std::thread::spawn(move || {
            read_with(&follower_key, deadline, || panic!("duplicate read"))
        });
        let started = Instant::now();
        while Arc::strong_count(&active) < 4 {
            assert!(started.elapsed() < Duration::from_secs(1));
            std::thread::yield_now();
        }
        release_tx.send(()).unwrap();
        assert_eq!(leader.join().unwrap().unwrap(), "synthetic");
        assert_eq!(follower.join().unwrap().unwrap(), "synthetic");
    }
    #[test]
    fn waiter_deadline_does_not_cancel_shared_reader() {
        let key = ("synthetic-wait-timeout".to_owned(), None);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let leader_key = key.clone();
        let leader = std::thread::spawn(move || {
            read_with(
                &leader_key,
                ProbeDeadline::at(Instant::now() + Duration::from_secs(2)),
                move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok("synthetic".into())
                },
            )
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let result = read_with(
            &key,
            ProbeDeadline::at(Instant::now() + Duration::from_millis(10)),
            || panic!("duplicate read"),
        );
        assert!(result.unwrap_err().starts_with("timedOut:"));
        release_tx.send(()).unwrap();
        assert_eq!(leader.join().unwrap().unwrap(), "synthetic");
    }
    #[test]
    fn expired_budget_prevents_spawn() {
        assert!(
            remaining(ProbeDeadline::at(Instant::now()))
                .unwrap_err()
                .starts_with("timedOut:")
        );
    }
    #[cfg(unix)]
    #[test]
    fn timed_out_process_and_its_child_are_reaped() {
        let start = Instant::now();
        let result = run_command(
            "/bin/sh",
            &["-c".into(), "sleep 30 & wait".into()],
            Duration::from_millis(30),
        );
        assert!(result.unwrap_err().starts_with("timedOut:"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[cfg(unix)]
    #[test]
    fn password_spaces_and_original_newline_are_preserved() {
        assert_eq!(
            run_command(
                "/bin/sh",
                &["-c".into(), "printf '  synthetic  \n\n'".into()],
                Duration::from_secs(1)
            )
            .unwrap(),
            "  synthetic  \n"
        );
    }
    #[cfg(unix)]
    #[test]
    fn successful_process_and_failed_process_are_classified() {
        assert_eq!(
            run_command(
                "/bin/sh",
                &["-c".into(), "printf synthetic".into()],
                Duration::from_secs(1)
            )
            .unwrap(),
            "synthetic"
        );
        assert!(
            run_command(
                "/bin/sh",
                &[
                    "-c".into(),
                    "printf 'authorization denied secret' >&2; exit 1".into()
                ],
                Duration::from_secs(1)
            )
            .unwrap_err()
            .starts_with("denied:")
        );
    }
}
