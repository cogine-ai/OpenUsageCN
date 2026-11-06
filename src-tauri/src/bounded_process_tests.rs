use super::*;
fn shell(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}
#[test]
fn expired_deadline_does_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spawned");
    let mut command = Command::new("/usr/bin/touch");
    command.arg(&path);
    assert_eq!(
        run(&mut command, None, Instant::now(), 1024)
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    assert!(!path.exists());
}
#[test]
fn stdin_and_both_output_pipes_are_drained_without_deadlock() {
    let bytes = vec![b'x'; 131072];
    let result = run(
        &mut shell("cat; printf safe-stderr >&2; exit 44"),
        Some(bytes.clone()),
        Instant::now() + Duration::from_secs(2),
        262144,
    )
    .unwrap();
    assert_eq!(result.status.code(), Some(44));
    assert_eq!(result.stdout, bytes);
    assert_eq!(result.stderr, b"safe-stderr");
}
#[test]
fn blocked_stdin_and_inherited_output_pipes_cannot_extend_the_deadline() {
    for (script, input) in [
        ("sleep 10", Some(vec![b'x'; 1_048_576])),
        ("(sleep 10)& exit 0", None),
    ] {
        let started = Instant::now();
        let error = run(
            &mut shell(script),
            input,
            started + Duration::from_millis(80),
            1024,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
#[test]
fn output_is_bounded_and_never_included_in_errors() {
    let error = run(
        &mut shell("printf '%02048d' 0"),
        None,
        Instant::now() + Duration::from_secs(2),
        1024,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(!error.to_string().contains("00000000"));
}
