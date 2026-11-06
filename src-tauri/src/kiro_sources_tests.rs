use super::*;
use std::cell::RefCell;

fn write(home: &Path, relative: &str, bytes: &[u8]) -> PathBuf {
    let path = home.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
}
fn selected(home: &Path, platform: &str, values: &[(&str, &str)]) -> Source {
    snapshot_at(home, platform, |names| {
        Ok(names
            .iter()
            .map(|name| {
                (
                    (*name).to_string(),
                    values
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| (*value).to_owned()),
                )
            })
            .collect())
    })
    .unwrap()
}
fn no_environment(_: &[&str]) -> Result<HashMap<String, Option<String>>, String> {
    panic!("desktop selection must not resolve CLI environment")
}

#[test]
fn desktop_content_and_optional_profile_changes_invalidate_the_source() {
    let home = tempfile::tempdir().unwrap();
    let token = write(home.path(), TOKEN, b"account-a");
    let a = snapshot_at(home.path(), "macos", no_environment).unwrap();
    assert!(a.environment.is_empty());
    fs::write(token, b"account-b").unwrap();
    let b = snapshot_at(home.path(), "macos", no_environment).unwrap();
    assert_ne!(a.fingerprint, b.fingerprint);
    let profile = write(home.path(), PROFILE, b"profile-a");
    let with_profile = snapshot_at(home.path(), "macos", no_environment).unwrap();
    assert_ne!(b.fingerprint, with_profile.fingerprint);
    fs::write(&profile, b"profile-b").unwrap();
    assert_ne!(
        with_profile.fingerprint,
        snapshot_at(home.path(), "macos", no_environment)
            .unwrap()
            .fingerprint
    );
    fs::remove_file(profile).unwrap();
    assert_eq!(
        b.fingerprint,
        snapshot_at(home.path(), "macos", no_environment)
            .unwrap()
            .fingerprint
    );
}

#[test]
fn invalid_but_existing_desktop_credentials_never_select_another_cli_account() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), TOKEN, b"invalid-json-secret-token");
    write(
        home.path(),
        "Library/Application Support/kiro-cli/data.sqlite3",
        b"different account",
    );
    let source = snapshot_at(home.path(), "macos", no_environment).unwrap();
    assert!(source.environment.is_empty());
    // JSON is deliberately not interpreted by this source guard; the plugin reports login errors.
    assert_eq!(source.fingerprint.len(), 64);
}

#[test]
fn missing_desktop_uses_cli_and_cli_database_or_wal_changes_invalidate_it() {
    let home = tempfile::tempdir().unwrap();
    let db = write(
        home.path(),
        "Library/Application Support/kiro-cli/data.sqlite3",
        b"a",
    );
    let initial = selected(home.path(), "macos", &[]);
    fs::write(&db, b"new database metadata").unwrap();
    let changed_db = selected(home.path(), "macos", &[]);
    assert_ne!(initial.fingerprint, changed_db.fingerprint);
    let wal = write(
        home.path(),
        "Library/Application Support/kiro-cli/data.sqlite3-wal",
        b"wal-a",
    );
    let with_wal = selected(home.path(), "macos", &[]);
    assert_ne!(changed_db.fingerprint, with_wal.fingerprint);
    fs::write(&wal, b"wal-account-b").unwrap();
    assert_ne!(
        with_wal.fingerprint,
        selected(home.path(), "macos", &[]).fingerprint
    );
    fs::remove_file(wal).unwrap();
    assert_eq!(
        changed_db.fingerprint,
        selected(home.path(), "macos", &[]).fingerprint
    );
    assert_eq!(
        initial.environment,
        HashMap::from([("KIRO_DATA_DIR".into(), None)])
    );
}

#[cfg(unix)]
#[test]
fn replacing_a_cli_database_with_equal_size_and_mtime_still_invalidates_the_source() {
    let home = tempfile::tempdir().unwrap();
    let db = write(
        home.path(),
        "Library/Application Support/kiro-cli/data.sqlite3",
        b"same size",
    );
    let previous = selected(home.path(), "macos", &[]);
    let modified = fs::metadata(&db).unwrap().modified().unwrap();
    let replacement = write(home.path(), "replacement.sqlite3", b"new login");
    fs::File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    fs::rename(replacement, db).unwrap();
    assert_ne!(
        previous.fingerprint,
        selected(home.path(), "macos", &[]).fingerprint
    );
}

#[test]
fn only_environment_values_used_to_select_the_source_are_captured() {
    let home = tempfile::tempdir().unwrap();
    let calls = RefCell::new(Vec::new());
    let first = snapshot_at(home.path(), "linux", |names| {
        calls.borrow_mut().push(
            names
                .iter()
                .map(|name| (*name).to_owned())
                .collect::<Vec<_>>(),
        );
        Ok(names
            .iter()
            .map(|name| {
                (
                    (*name).to_owned(),
                    (*name == "KIRO_DATA_DIR").then(|| "~/cli-a".into()),
                )
            })
            .collect())
    })
    .unwrap();
    assert_eq!(*calls.borrow(), vec![vec!["KIRO_DATA_DIR"]]);
    assert_eq!(
        first.environment,
        HashMap::from([("KIRO_DATA_DIR".into(), Some("~/cli-a".into()))])
    );
    let second = selected(home.path(), "linux", &[("KIRO_DATA_DIR", "~/cli-b")]);
    assert_ne!(first.fingerprint, second.fingerprint);
    // With no override, non-macOS source selection also captures XDG_DATA_HOME.
    let xdg = selected(home.path(), "linux", &[("XDG_DATA_HOME", "~/xdg-a")]);
    assert_eq!(xdg.environment.len(), 2);
    write(
        home.path(),
        "xdg-a/kiro-cli/data.sqlite3",
        b"synthetic xdg database",
    );
    assert_ne!(
        xdg.fingerprint,
        selected(home.path(), "linux", &[("XDG_DATA_HOME", "~/xdg-a")]).fingerprint
    );
}

#[test]
fn a_desktop_sign_in_appearing_after_cli_selection_changes_the_source() {
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "Library/Application Support/kiro-cli/data.sqlite3",
        b"CLI account",
    );
    let cli = selected(home.path(), "macos", &[]);
    write(home.path(), TOKEN, b"desktop account");
    let desktop = snapshot_at(home.path(), "macos", no_environment).unwrap();
    assert_ne!(cli.fingerprint, desktop.fingerprint);
    assert!(desktop.environment.is_empty());
}

#[test]
fn usage_logs_and_caches_do_not_change_credential_source_identity() {
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        "Library/Application Support/kiro-cli/data.sqlite3",
        b"CLI account",
    );
    let before = selected(home.path(), "macos", &[]);
    write(
        home.path(),
        "Library/Application Support/Kiro/logs/session/q-client.log",
        b"new usage log",
    );
    write(
        home.path(),
        "Library/Application Support/Kiro/User/globalStorage/state.vscdb",
        b"new desktop usage cache",
    );
    assert_eq!(
        before.fingerprint,
        selected(home.path(), "macos", &[]).fingerprint
    );
}

#[test]
fn invalid_paths_and_unresolved_environment_fail_instead_of_guessing_another_source() {
    let home = tempfile::tempdir().unwrap();
    for value in [
        "invalid\0path",
        "path\nwith-line-break",
        "path\twith-tab",
        "path\u{7f}",
    ] {
        let result = snapshot_at(home.path(), "macos", |_| {
            Ok(HashMap::from([(
                "KIRO_DATA_DIR".into(),
                Some(value.into()),
            )]))
        });
        assert!(result.is_err());
    }
    assert!(snapshot_at(home.path(), "macos", |_| Err(
        "synthetic unresolved environment".into()
    ))
    .is_err());
    // A directory at the credential filename is an invalid existing desktop source, not absence.
    fs::create_dir_all(home.path().join(TOKEN)).unwrap();
    assert!(snapshot_at(home.path(), "macos", no_environment).is_err());
}

#[test]
fn oversized_credential_files_are_rejected_without_cli_fallback() {
    let home = tempfile::tempdir().unwrap();
    write(
        home.path(),
        TOKEN,
        &vec![b'a'; MAX_CREDENTIAL_BYTES as usize + 1],
    );
    assert!(snapshot_at(home.path(), "macos", no_environment).is_err());
    write(home.path(), TOKEN, b"bounded token");
    write(
        home.path(),
        PROFILE,
        &vec![b'a'; MAX_CREDENTIAL_BYTES as usize + 1],
    );
    assert!(snapshot_at(home.path(), "macos", no_environment).is_err());
}

#[cfg(unix)]
#[test]
fn broken_existing_desktop_links_and_denied_reads_cannot_fall_back_to_cli() {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{symlink, PermissionsExt},
    };
    let home = tempfile::tempdir().unwrap();
    let token = home.path().join(TOKEN);
    fs::create_dir_all(token.parent().unwrap()).unwrap();
    symlink(home.path().join("missing-target"), &token).unwrap();
    assert!(snapshot_at(home.path(), "macos", no_environment).is_err());
    fs::remove_file(&token).unwrap();
    write(home.path(), TOKEN, b"private synthetic token");
    fs::set_permissions(&token, fs::Permissions::from_mode(0o000)).unwrap();
    if unsafe { libc::geteuid() } != 0 {
        assert!(snapshot_at(home.path(), "macos", no_environment).is_err());
    }
    fs::set_permissions(&token, fs::Permissions::from_mode(0o600)).unwrap();
    // Non-UTF8 paths fail encoding without including the path or credentials in the error.
    let invalid = home
        .path()
        .join(std::ffi::OsStr::from_bytes(b"invalid-\xff"));
    assert!(source("missing", &invalid, BTreeMap::new(), &()).is_err());
}

#[test]
#[serial_test::serial]
fn an_unconfigured_source_and_the_public_test_entrypoint_are_stable() {
    let home = tempfile::tempdir().unwrap();
    let a = selected(home.path(), "macos", &[]);
    let b = selected(home.path(), "macos", &[]);
    assert_eq!(a.fingerprint, b.fingerprint);
    assert_eq!(
        snapshot().unwrap().fingerprint,
        snapshot().unwrap().fingerprint
    );
}
