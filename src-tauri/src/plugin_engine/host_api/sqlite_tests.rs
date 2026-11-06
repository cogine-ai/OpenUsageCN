use super::*;

#[test]
fn database_names_cannot_be_options_and_sql_is_not_in_arguments() {
    for readonly in [true, false] {
        for (path, filename) in [
            ("-init", "./-init"),
            ("--", "./--"),
            ("-", "./-"),
            (":memory:", ":memory:"),
            ("normal.db", "normal.db"),
            ("sub/-init", "sub/-init"),
            ("file:normal.db?immutable=1", "file:normal.db?immutable=1"),
        ] {
            let command = sqlite_command(path, readonly);
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect();
            let expected = if readonly {
                vec!["-readonly", "-json", filename]
            } else {
                vec![filename]
            };
            assert_eq!(args, expected);
        }
    }
}

#[test]
fn expired_sqlite_budget_does_not_start_fallback_or_create_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.sqlite3");
    assert_eq!(
        read(path.to_str().unwrap(), "SELECT 1", false, Instant::now()),
        Err("SQLite read timed out. Try again.")
    );
    assert!(!path.exists());
}

#[test]
fn stdin_transport_keeps_dot_commands_blocked_in_every_host_method() {
    let runtime = rquickjs::Runtime::new().unwrap();
    rquickjs::Context::full(&runtime).unwrap().with(|vm| {
        let host = Object::new(vm.clone()).unwrap();
        inject(&vm, &host, ProbeDeadline::at(Instant::now() + Duration::from_secs(2))).unwrap();
        vm.globals().set("sqlite", host.get::<_, Object>("sqlite").unwrap()).unwrap();
        for method in ["query", "queryReadOnly", "exec"] {
            let error: String = vm.eval(format!("try {{ sqlite.{method}('-init', '\\n  .print INJECTION_MARKER'); 'unexpected success' }} catch(error) {{ String(error) }}")).unwrap();
            assert!(error.contains("sqlite3 dot-commands are not allowed"));
        }
    });
}

#[cfg(unix)]
mod real_process {
    use super::*;
    use std::ffi::OsString;
    use std::path::Path;

    struct Fixture {
        directory: tempfile::TempDir,
        program: OsString,
    }
    fn fixtures() -> Vec<Fixture> {
        let newer = std::env::var_os("OPENUSAGE_TEST_SQLITE_NEW");
        let mut fixtures = Vec::new();
        if let Some(fixture) = Fixture::new(
            newer.clone().unwrap_or_else(|| "sqlite3".into()),
            newer.is_some(),
            None,
        ) {
            fixtures.push(fixture);
        }
        if let Some(older) = std::env::var_os("OPENUSAGE_TEST_SQLITE_OLD") {
            fixtures.push(Fixture::new(older, true, Some("3.39.4")).unwrap());
        }
        fixtures
    }
    impl Fixture {
        fn new(program: OsString, required: bool, expected_version: Option<&str>) -> Option<Self> {
            let fixture = Self {
                directory: tempfile::tempdir().unwrap(),
                program,
            };
            std::fs::write(fixture.directory().join("empty-init.sql"), "").unwrap();
            match fixture.run(":memory:", "SELECT sqlite_version() AS version", true) {
                Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => {
                    eprintln!("sqlite3 is unavailable; skipping the optional Unix process fixture");
                    None
                }
                Err(error) => panic!("synthetic sqlite3 fixture failed: {error}"),
                Ok(output) => {
                    assert!(
                        output.status.success(),
                        "SQLite fixture could not read its version"
                    );
                    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                    if let Some(version) = expected_version {
                        assert_eq!(rows[0]["version"], version);
                    }
                    Some(fixture)
                }
            }
        }
        fn directory(&self) -> &Path {
            self.directory.path()
        }
        fn run(&self, path: &str, sql: &str, readonly: bool) -> std::io::Result<Output> {
            // Prefix production arguments with a trusted empty init file so no test
            // loads ~/.sqliterc. The old/new override selects only this test process.
            let production = sqlite_command(path, readonly);
            let mut command = Command::new(&self.program);
            command
                .arg("-init")
                .arg(self.directory().join("empty-init.sql"))
                .args(production.get_args())
                .current_dir(self.directory());
            crate::bounded_process::run(
                &mut command,
                Some(sql.as_bytes().to_vec()),
                Instant::now() + Duration::from_secs(2),
                8 * 1024 * 1024,
            )
        }
    }
    #[test]
    fn leading_dash_database_cannot_execute_an_init_script_in_either_mode() {
        for fixture in fixtures() {
            assert!(fixture
                .run(
                    "-init",
                    "CREATE TABLE usage(value TEXT); INSERT INTO usage VALUES('synthetic');",
                    false
                )
                .unwrap()
                .status
                .success());
            assert!(fixture.directory().join("-init").is_file());
            let script = fixture.directory().join("benign-init.sql");
            std::fs::write(&script, ".print INJECTION_MARKER\n").unwrap();
            for readonly in [true, false] {
                let output = fixture
                    .run("-init", script.to_str().unwrap(), readonly)
                    .unwrap();
                assert!(!output.status.success(), "a script filename is invalid SQL");
                for stream in [&output.stdout, &output.stderr] {
                    assert!(!String::from_utf8_lossy(stream).contains("INJECTION_MARKER"));
                }
            }
            let output = fixture
                .run("-init", "SELECT value FROM usage", true)
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
                serde_json::json!([{"value":"synthetic"}])
            );
        }
    }
    #[test]
    fn leading_dash_sql_is_sql_not_a_cli_option() {
        for fixture in fixtures() {
            let script = fixture.directory().join("benign-init.sql");
            std::fs::write(&script, ".print INJECTION_MARKER\n").unwrap();
            for readonly in [true, false] {
                for sql in [
                    "-version".to_string(),
                    format!("-init {}", script.display()),
                ] {
                    let output = fixture.run(":memory:", &sql, readonly).unwrap();
                    assert!(!output.status.success());
                    assert!(
                        output.stdout.is_empty(),
                        "SQL must not print a CLI version or init marker"
                    );
                    assert!(!String::from_utf8_lossy(&output.stderr).contains("INJECTION_MARKER"));
                }
            }
        }
    }
    #[test]
    fn normal_json_queries_and_exec_work_and_readonly_still_rejects_writes() {
        for fixture in fixtures() {
            assert!(fixture
                .run(
                    "usage.sqlite3",
                    "CREATE TABLE usage(value INTEGER); INSERT INTO usage VALUES(1);",
                    false
                )
                .unwrap()
                .status
                .success());
            assert!(!fixture
                .run("usage.sqlite3", "INSERT INTO usage VALUES(2)", true)
                .unwrap()
                .status
                .success());
            assert!(fixture
                .run("usage.sqlite3", "INSERT INTO usage VALUES(3)", false)
                .unwrap()
                .status
                .success());
            for path in [
                "usage.sqlite3".to_string(),
                format!(
                    "file:{}?immutable=1",
                    fixture.directory().join("usage.sqlite3").display()
                ),
            ] {
                let output = fixture
                    .run(&path, "SELECT value FROM usage ORDER BY value", true)
                    .unwrap();
                assert!(output.status.success());
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
                    serde_json::json!([{"value":1},{"value":3}])
                );
            }
        }
    }
    #[test]
    fn strict_read_command_never_creates_a_missing_database() {
        for fixture in fixtures() {
            assert!(!fixture
                .run("missing.sqlite3", "SELECT 1", true)
                .unwrap()
                .status
                .success());
            assert!(!fixture.directory().join("missing.sqlite3").exists());
        }
    }
}
