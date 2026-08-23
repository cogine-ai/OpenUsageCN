use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

const SIDECAR_NAME: &str = "openusage-cookie-helper";
const STDERR_LIMIT: usize = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);

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
    let mut child = Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ProcessRunError::Failed)?;

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
        return Err(error);
    }

    let Some(stdout) = child.stdout.take() else {
        terminate(&mut child);
        return Err(ProcessRunError::Failed);
    };
    let Some(stderr) = child.stderr.take() else {
        terminate(&mut child);
        return Err(ProcessRunError::Failed);
    };
    let stdout_receiver = read_stream(stdout, stdout_limit);
    let stderr_receiver = read_stream(stderr, STDERR_LIMIT);
    wait_for_output(&mut child, stdout_receiver, stderr_receiver, timeout)
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
