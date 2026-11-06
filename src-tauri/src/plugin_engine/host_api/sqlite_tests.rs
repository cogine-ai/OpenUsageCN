use super::*;

#[test]
fn database_names_follow_the_option_terminator_in_both_modes() {
    for readonly in [true, false] {
        let command = sqlite_command("-init", "SELECT 1", readonly);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        let expected = if readonly {
            vec!["-readonly", "-json", "--", "-init", "SELECT 1"]
        } else {
            vec!["--", "-init", "SELECT 1"]
        };
        assert_eq!(args, expected);
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

#[cfg(unix)]
mod real_process {
    use super::*;
    use std::path::Path;

    struct Fixture {
        directory: tempfile::TempDir,
    }
    impl Fixture {
        fn new() -> Option<Self> {
            let fixture = Self {
                directory: tempfile::tempdir().unwrap(),
            };
            std::fs::write(fixture.directory.path().join("empty-init.sql"), "").unwrap();
            match fixture.run(":memory:", "SELECT 1 AS value", true) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    eprintln!("sqlite3 is unavailable; skipping the optional Unix process fixture");
                    None
                }
                Err(error) => panic!("synthetic sqlite3 fixture failed: {error}"),
                Ok(output) => {
                    assert!(output.status.success());
                    Some(fixture)
                }
            }
        }
        fn directory(&self) -> &Path {
            self.directory.path()
        }
        fn run(&self, path: &str, sql: &str, readonly: bool) -> std::io::Result<Output> {
            // Prefix the actual production arguments with a trusted empty init file.
            // This prevents tests from loading the developer's ~/.sqliterc without
            // changing global cwd, PATH, HOME, or the production command behavior.
            let production = sqlite_command(path, sql, readonly);
            let mut command = Command::new(production.get_program());
            command
                .arg("-init")
                .arg(self.directory().join("empty-init.sql"))
                .args(production.get_args())
                .current_dir(self.directory());
            crate::bounded_process::run(
                &mut command,
                None,
                Instant::now() + Duration::from_secs(2),
                8 * 1024 * 1024,
            )
        }
    }
    #[test]
    fn leading_dash_database_cannot_execute_an_init_script_in_either_mode() {
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let initialized = fixture
            .run(
                "-init",
                "CREATE TABLE usage(value TEXT); INSERT INTO usage VALUES('synthetic');",
                false,
            )
            .unwrap();
        assert!(initialized.status.success());
        assert!(fixture.directory().join("-init").is_file());
        let script = fixture.directory().join("benign-init.sql");
        std::fs::write(&script, ".print INJECTION_MARKER\n").unwrap();
        for readonly in [true, false] {
            let output = fixture
                .run("-init", script.to_str().unwrap(), readonly)
                .unwrap();
            assert!(
                !output.status.success(),
                "an absolute script filename is invalid SQL"
            );
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
    #[test]
    fn normal_json_queries_and_exec_work_and_readonly_still_rejects_writes() {
        let Some(fixture) = Fixture::new() else {
            return;
        };
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
    #[test]
    fn strict_read_command_never_creates_a_missing_database() {
        let Some(fixture) = Fixture::new() else {
            return;
        };
        let output = fixture.run("missing.sqlite3", "SELECT 1", true).unwrap();
        assert!(!output.status.success());
        assert!(!fixture.directory().join("missing.sqlite3").exists());
    }
}
