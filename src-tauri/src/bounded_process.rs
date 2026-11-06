//! Raw subprocess execution with a single deadline for stdin, exit and both output pipes.
use std::io::{self, Read, Write};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub(crate) fn run(
    command: &mut Command,
    input: Option<Vec<u8>>,
    deadline: Instant,
    limit: usize,
) -> io::Result<Output> {
    if Instant::now() >= deadline {
        return Err(timeout());
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let drain = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream
                .take(limit.saturating_add(1) as u64)
                .read_to_end(&mut bytes)?;
            Ok::<_, io::Error>(bytes)
        })
    };
    let stdout = drain(Box::new(child.stdout.take().expect("piped stdout")));
    let stderr = drain(Box::new(child.stderr.take().expect("piped stderr")));
    let writer = input.map(|mut bytes| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || {
            let result = stdin.write_all(&bytes);
            bytes.fill(0);
            result
        })
    });
    let terminate = |child: &mut std::process::Child| {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    loop {
        if Instant::now() >= deadline {
            terminate(&mut child);
            // Never join an unfinished pipe worker: an inherited pipe must not defeat the deadline.
            return Err(timeout());
        }
        match child.try_wait() {
            Ok(Some(status))
                if stdout.is_finished()
                    && stderr.is_finished()
                    && writer.as_ref().is_none_or(|writer| writer.is_finished()) =>
            {
                let stdout = stdout.join().map_err(|_| worker_error())??;
                let stderr = stderr.join().map_err(|_| worker_error())??;
                if let Some(writer) = writer {
                    writer.join().map_err(|_| worker_error())??;
                }
                if stdout.len() > limit || stderr.len() > limit {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "process output exceeded its limit",
                    ));
                }
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Err(error) => {
                terminate(&mut child);
                return Err(error);
            }
            _ => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}
fn timeout() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "process deadline elapsed")
}
fn worker_error() -> io::Error {
    io::Error::other("process pipe worker failed")
}

#[cfg(all(test, unix))]
#[path = "bounded_process_tests.rs"]
mod tests;
