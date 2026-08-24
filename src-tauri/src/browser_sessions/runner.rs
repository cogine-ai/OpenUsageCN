use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

const SIDECAR_NAME: &str = "openusage-cookie-helper";
const STDERR_LIMIT: usize = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
#[cfg(target_os = "macos")]
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
#[cfg(target_os = "macos")]
const PRESERVED_ENVIRONMENT: [&str; 6] = [
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_CTYPE",
    "__CF_USER_TEXT_ENCODING",
];

pub(crate) struct ProcessOutput {
    pub stdout: Vec<u8>,
}

impl Drop for ProcessOutput {
    fn drop(&mut self) {
        self.stdout.fill(0);
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ProcessRunError {
    TimedOut,
    OutputTooLarge,
    Failed,
}

pub(crate) trait SidecarRunner: Send + Sync {
    fn run(
        &self,
        request: &[u8],
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError>;
}

pub(super) struct FixedSidecarRunner;

impl SidecarRunner for FixedSidecarRunner {
    fn run(
        &self,
        request: &[u8],
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        #[cfg(target_os = "macos")]
        {
            let executable = std::env::current_exe().map_err(|_| ProcessRunError::Failed)?;
            let executable_directory = executable.parent().ok_or(ProcessRunError::Failed)?;
            let sidecar_directory = if executable_directory.ends_with("deps") {
                executable_directory
                    .parent()
                    .unwrap_or(executable_directory)
            } else {
                executable_directory
            };
            let sidecar = sidecar_directory.join(SIDECAR_NAME);
            run_sidecar(&sidecar, request, timeout, stdout_limit)
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (request, timeout, stdout_limit);
            Err(ProcessRunError::Failed)
        }
    }
}

#[cfg(target_os = "macos")]
fn run_sidecar(
    executable: &std::path::Path,
    request: &[u8],
    timeout: Duration,
    stdout_limit: usize,
) -> Result<ProcessOutput, ProcessRunError> {
    let temporary_root = tempfile::Builder::new()
        .prefix("openusage-cookie-helper-")
        .tempdir()
        .map_err(|_| ProcessRunError::Failed)?;
    let working_directory = executable.parent().ok_or(ProcessRunError::Failed)?;
    let mut command = Command::new(executable);
    command
        .env_clear()
        .env("PATH", SYSTEM_PATH)
        .env("TMPDIR", temporary_root.path())
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in PRESERVED_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().map_err(|_| ProcessRunError::Failed)?;

    let write_result = child
        .stdin
        .take()
        .ok_or(ProcessRunError::Failed)
        .and_then(|mut stdin| {
            stdin
                .write_all(request)
                .map_err(|_| ProcessRunError::Failed)
        });
    if let Err(error) = write_result {
        terminate(&mut child);
        return finish_with_cleanup(temporary_root, Err(error));
    }

    let Some(stdout) = child.stdout.take() else {
        terminate(&mut child);
        return finish_with_cleanup(temporary_root, Err(ProcessRunError::Failed));
    };
    let Some(stderr) = child.stderr.take() else {
        terminate(&mut child);
        return finish_with_cleanup(temporary_root, Err(ProcessRunError::Failed));
    };
    let stdout_receiver = read_stream(stdout, stdout_limit);
    let stderr_receiver = read_stream(stderr, STDERR_LIMIT);
    let result = wait_for_output(&mut child, stdout_receiver, stderr_receiver, timeout);
    finish_with_cleanup(temporary_root, result)
}

#[cfg(target_os = "macos")]
fn finish_with_cleanup(
    temporary_root: tempfile::TempDir,
    result: Result<ProcessOutput, ProcessRunError>,
) -> Result<ProcessOutput, ProcessRunError> {
    if temporary_root.close().is_err() {
        return Err(ProcessRunError::Failed);
    }
    result
}

#[cfg(target_os = "macos")]
fn read_stream<R: Read + Send + 'static>(
    reader: R,
    limit: usize,
) -> mpsc::Receiver<Result<Vec<u8>, ProcessRunError>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        if let Err(send_error) = sender.send(read_bounded(reader, limit)) {
            if let Ok(mut bytes) = send_error.0 {
                bytes.fill(0);
            }
        }
    });
    receiver
}

#[cfg(target_os = "macos")]
fn read_bounded<R: Read>(mut reader: R, limit: usize) -> Result<Vec<u8>, ProcessRunError> {
    let mut output = Vec::with_capacity(limit.min(16 * 1024));
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let count = match reader.read(&mut chunk) {
            Ok(count) => count,
            Err(_) => {
                output.fill(0);
                chunk.fill(0);
                return Err(ProcessRunError::Failed);
            }
        };
        if count == 0 {
            chunk.fill(0);
            return Ok(output);
        }
        if output.len().saturating_add(count) > limit {
            output.fill(0);
            chunk.fill(0);
            return Err(ProcessRunError::OutputTooLarge);
        }
        output.extend_from_slice(&chunk[..count]);
        chunk[..count].fill(0);
    }
}

#[cfg(target_os = "macos")]
fn wait_for_output(
    child: &mut Child,
    stdout_receiver: mpsc::Receiver<Result<Vec<u8>, ProcessRunError>>,
    stderr_receiver: mpsc::Receiver<Result<Vec<u8>, ProcessRunError>>,
    timeout: Duration,
) -> Result<ProcessOutput, ProcessRunError> {
    let deadline = Instant::now() + timeout;
    let mut stdout = None;
    let mut stderr = None;

    loop {
        if let Err(error) = receive_stream(&stdout_receiver, &mut stdout) {
            terminate(child);
            clear_streams(&mut stdout, &mut stderr);
            clear_receiver(&stderr_receiver);
            return Err(error);
        }
        if let Err(error) = receive_stream(&stderr_receiver, &mut stderr) {
            terminate(child);
            clear_streams(&mut stdout, &mut stderr);
            clear_receiver(&stdout_receiver);
            return Err(match error {
                ProcessRunError::OutputTooLarge => ProcessRunError::Failed,
                other => other,
            });
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout_result = finish_stream(stdout, &stdout_receiver);
                let stderr_result = finish_stream(stderr, &stderr_receiver);
                let mut stdout = match stdout_result {
                    Ok(stdout) => stdout,
                    Err(error) => {
                        if let Ok(mut stderr) = stderr_result {
                            stderr.fill(0);
                        }
                        return Err(error);
                    }
                };
                let mut stderr = match stderr_result {
                    Ok(stderr) => stderr,
                    Err(error) => {
                        stdout.fill(0);
                        return Err(error);
                    }
                };
                stderr.fill(0);
                if !status.success() {
                    stdout.fill(0);
                    return Err(ProcessRunError::Failed);
                }
                return Ok(ProcessOutput { stdout });
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                terminate(child);
                clear_streams(&mut stdout, &mut stderr);
                clear_receiver(&stdout_receiver);
                clear_receiver(&stderr_receiver);
                return Err(ProcessRunError::TimedOut);
            }
            Err(_) => {
                terminate(child);
                clear_streams(&mut stdout, &mut stderr);
                clear_receiver(&stdout_receiver);
                clear_receiver(&stderr_receiver);
                return Err(ProcessRunError::Failed);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn receive_stream(
    receiver: &mpsc::Receiver<Result<Vec<u8>, ProcessRunError>>,
    slot: &mut Option<Vec<u8>>,
) -> Result<(), ProcessRunError> {
    if slot.is_some() {
        return Ok(());
    }
    match receiver.try_recv() {
        Ok(Ok(bytes)) => {
            *slot = Some(bytes);
            Ok(())
        }
        Ok(Err(error)) => Err(error),
        Err(TryRecvError::Empty) => Ok(()),
        Err(TryRecvError::Disconnected) => Err(ProcessRunError::Failed),
    }
}

#[cfg(target_os = "macos")]
fn finish_stream(
    current: Option<Vec<u8>>,
    receiver: &mpsc::Receiver<Result<Vec<u8>, ProcessRunError>>,
) -> Result<Vec<u8>, ProcessRunError> {
    match current {
        Some(bytes) => Ok(bytes),
        None => receiver.recv().map_err(|_| ProcessRunError::Failed)?,
    }
}

#[cfg(target_os = "macos")]
fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(target_os = "macos")]
fn clear_streams(stdout: &mut Option<Vec<u8>>, stderr: &mut Option<Vec<u8>>) {
    if let Some(stdout) = stdout {
        stdout.fill(0);
    }
    if let Some(stderr) = stderr {
        stderr.fill(0);
    }
}

#[cfg(target_os = "macos")]
fn clear_receiver(receiver: &mpsc::Receiver<Result<Vec<u8>, ProcessRunError>>) {
    if let Ok(Ok(mut bytes)) = receiver.recv_timeout(Duration::from_millis(100)) {
        bytes.fill(0);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{ProcessRunError, run_sidecar};
    use serial_test::serial;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct EnvironmentGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvironmentGuard {
        fn set(values: &[(&'static str, &str)]) -> Self {
            let previous = values
                .iter()
                .map(|(name, _)| (*name, std::env::var_os(name)))
                .collect();
            for (name, value) in values {
                unsafe { std::env::set_var(name, value) };
            }
            Self(previous)
        }
    }

    impl Drop for EnvironmentGuard {
        fn drop(&mut self) {
            for (name, value) in self.0.drain(..) {
                match value {
                    Some(value) => unsafe { std::env::set_var(name, value) },
                    None => unsafe { std::env::remove_var(name) },
                }
            }
        }
    }

    fn write_executable(path: &Path, body: &str) {
        fs::write(path, body).expect("write fake sidecar");
        let mut permissions = fs::metadata(path).expect("fake metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("make fake sidecar executable");
    }

    #[test]
    #[serial]
    fn sidecar_uses_a_curated_environment_and_runner_owned_temporary_directory() {
        let fake_root = TestDirectory::new("openusage-runner-environment");
        let inherited_temp = TestDirectory::new("openusage-inherited-temp");
        let marker = fake_root.path().join("environment.txt");
        let sidecar = fake_root.path().join("fake-sidecar");
        write_executable(
            &sidecar,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"${{BUN_OPTIONS-unset}}\" \"${{NODE_OPTIONS-unset}}\" \"${{DYLD_INSERT_LIBRARIES-unset}}\" \"$PATH\" \"$TMPDIR\" \"$PWD\" > '{}'\nprintf ok\n",
                marker.display()
            ),
        );
        let _environment = EnvironmentGuard::set(&[
            ("BUN_OPTIONS", "--preload=/tmp/injected.js"),
            ("NODE_OPTIONS", "--require=/tmp/injected.js"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/injected.dylib"),
            (
                "TMPDIR",
                inherited_temp.path().to_str().expect("utf-8 temp path"),
            ),
        ]);

        let output = match run_sidecar(&sidecar, b"{}\n", Duration::from_secs(1), 1_024) {
            Ok(output) => output,
            Err(_) => panic!("fake sidecar must run"),
        };
        assert_eq!(output.stdout, b"ok");
        let observed = fs::read_to_string(&marker).expect("read environment marker");
        let lines = observed.lines().collect::<Vec<_>>();
        assert_eq!(
            &lines[..4],
            ["unset", "unset", "unset", "/usr/bin:/bin:/usr/sbin:/sbin"]
        );
        assert_ne!(Path::new(lines[4]), inherited_temp.path());
        assert!(Path::new(lines[4]).starts_with(inherited_temp.path()));
        assert!(!Path::new(lines[4]).exists());
        assert_eq!(
            fs::canonicalize(lines[5]).expect("canonical child cwd"),
            fs::canonicalize(fake_root.path()).expect("canonical fake root"),
        );
    }

    #[test]
    #[serial]
    fn sidecar_timeout_removes_snapshot_tree_owned_by_the_parent() {
        let fake_root = TestDirectory::new("openusage-runner-timeout");
        let inherited_temp = TestDirectory::new("openusage-timeout-parent");
        let marker = fake_root.path().join("snapshot-path.txt");
        let sidecar = fake_root.path().join("fake-sidecar");
        write_executable(
            &sidecar,
            &format!(
                "#!/bin/sh\nsnapshot=\"$TMPDIR/sweet-cookie-snapshot\"\nmkdir \"$snapshot\"\nprintf '%s' \"$snapshot\" > '{}'\nwhile :; do :; done\n",
                marker.display()
            ),
        );
        let _environment = EnvironmentGuard::set(&[(
            "TMPDIR",
            inherited_temp.path().to_str().expect("utf-8 temp path"),
        )]);

        let result = run_sidecar(&sidecar, b"{}\n", Duration::from_secs(1), 1_024);
        assert!(matches!(result, Err(ProcessRunError::TimedOut)));
        let snapshot = PathBuf::from(fs::read_to_string(marker).expect("read snapshot marker"));
        let was_left_behind = snapshot.exists();
        let _ = fs::remove_dir_all(&snapshot);
        assert!(
            !was_left_behind,
            "runner must clean snapshots after killing the helper"
        );
    }
}
