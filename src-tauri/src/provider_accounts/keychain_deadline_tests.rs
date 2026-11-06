use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

struct DeadlineRunner {
    deadline: Instant,
    calls: AtomicUsize,
}
impl CommandRunner for DeadlineRunner {
    fn run(&self, _args: &[String], _stdin: Option<&[u8]>) -> io::Result<CommandResult> {
        let step = self.calls.fetch_add(1, Ordering::SeqCst);
        let script = match step {
            0 => "sleep 0.02; exit 44",
            1 => "sleep 0.02; exit 45",
            _ => "sleep 1; printf aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        };
        let output = crate::bounded_process::run(
            std::process::Command::new("/bin/sh").args(["-c", script]),
            None,
            self.deadline,
            65536,
        )?;
        Ok(CommandResult {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}
#[test]
fn missing_create_and_duplicate_reread_share_one_absolute_budget() {
    let started = Instant::now();
    let runner = DeadlineRunner {
        deadline: started + Duration::from_millis(400),
        calls: AtomicUsize::new(0),
    };
    let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));
    assert_eq!(store.read().err(), Some(InstallationKeyError::Missing));
    assert_eq!(store.create().err(), Some(InstallationKeyError::Timeout));
    assert_eq!(runner.calls.load(Ordering::SeqCst), 3);
    assert!(started.elapsed() < Duration::from_millis(1500));
}
