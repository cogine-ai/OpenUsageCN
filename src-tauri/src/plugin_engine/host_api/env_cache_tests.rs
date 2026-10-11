use super::*;

#[cfg(unix)]
#[test]
fn confirmed_absent_environment_is_cached_without_launching_the_shell_again() {
    use std::os::unix::fs::PermissionsExt;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("OPENUSAGECN_ABSENT_ENV_TEST_{id}");
    let dir = std::env::temp_dir().join(format!("openusagecn-env-cache-{id}"));
    std::fs::create_dir(&dir).expect("create test directory");
    let program = dir.join("fake-shell.sh");
    std::fs::write(
        &program,
        r#"#!/bin/sh
printf 'called\n' >> "$0.calls"
printf '__OPENUSAGECN_ENV_START_0__\n__OPENUSAGECN_ENV_END_0__\n'
"#,
    )
    .expect("write fake shell");
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
        .expect("make fake shell executable");
    let programs = vec![program.to_string_lossy().into_owned()];

    let first = resolve_env_values_using_shells(&[&name], &programs);
    assert!(first.unresolved.is_empty());
    assert_eq!(first.values.get(&name), Some(&None));
    assert_eq!(
        terminal_env_cache().lock().expect("env cache").get(&name),
        Some(&None)
    );
    let second = resolve_env_values_using_shells(&[&name], &programs);
    assert!(second.unresolved.is_empty());
    assert_eq!(second.values.get(&name), Some(&None));
    let calls = std::fs::read_to_string(dir.join("fake-shell.sh.calls")).expect("shell calls");
    assert_eq!(
        calls.lines().count(),
        1,
        "a known missing value must not reopen the shell"
    );

    std::fs::remove_dir_all(dir).expect("remove test directory");
}
