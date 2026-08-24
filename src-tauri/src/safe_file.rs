use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
const WINDOWS_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(50),
    Duration::from_millis(150),
    Duration::from_millis(300),
];

pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    write_bytes(path, content.as_bytes())
}

pub fn write_text_if_unchanged(
    path: &Path,
    content: &str,
    expected_sha256: &str,
) -> Result<bool, String> {
    write_bytes_inner(path, content.as_bytes(), Some(expected_sha256))
}

pub fn write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    write_bytes_inner(path, content, None).map(|_| ())
}

fn write_bytes_inner(
    path: &Path,
    content: &[u8],
    expected_sha256: Option<&str>,
) -> Result<bool, String> {
    let destination = resolve_write_destination(path)?;
    if let Some(parent) = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create destination directory: {error}"))?;
    }
    let temp = temporary_path(&destination);

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("failed to create temporary file: {error}"))?;
        file.write_all(content)
            .map_err(|error| format!("failed to write temporary file: {error}"))?;
        file.flush()
            .map_err(|error| format!("failed to flush temporary file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync temporary file: {error}"))?;
        drop(file);
        replace_with_retry(&temp, &destination, expected_sha256)
            .map_err(|error| format!("failed to replace destination file: {error}"))
    })();

    match result {
        Ok(true) => Ok(true),
        Ok(false) => {
            // Digest mismatch: destination is intact; discard the unused replacement.
            let _ = std::fs::remove_file(&temp);
            Ok(false)
        }
        Err(error) => match cleanup_temp_after_failed_write(&temp, &destination) {
            // ReplaceFileW can delete the destination before failing (errors 1176/1177
            // without a backup name). Promote the synced temp so credentials survive.
            TempCleanupOutcome::Recovered => Ok(true),
            TempCleanupOutcome::Removed | TempCleanupOutcome::LeftInPlace => Err(error),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TempCleanupOutcome {
    Removed,
    Recovered,
    LeftInPlace,
}

/// Clean up a temp replacement after a failed write without discarding the only
/// remaining credential bytes when the destination was already removed.
fn cleanup_temp_after_failed_write(temp: &Path, destination: &Path) -> TempCleanupOutcome {
    if destination.exists() {
        let _ = std::fs::remove_file(temp);
        return TempCleanupOutcome::Removed;
    }
    if !temp.exists() {
        return TempCleanupOutcome::LeftInPlace;
    }
    match std::fs::rename(temp, destination) {
        Ok(()) => TempCleanupOutcome::Recovered,
        Err(_) => TempCleanupOutcome::LeftInPlace,
    }
}

pub(crate) fn sha256_hex(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

#[cfg(not(target_os = "windows"))]
fn destination_matches(path: &Path, expected_sha256: &str) -> io::Result<bool> {
    match std::fs::read(path) {
        Ok(content) => Ok(sha256_hex(&content) == expected_sha256),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn resolve_write_destination(path: &Path) -> Result<PathBuf, String> {
    let mut destination = path.to_path_buf();
    for _ in 0..40 {
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = std::fs::read_link(&destination)
                    .map_err(|error| format!("failed to resolve destination symlink: {error}"))?;
                destination = if target.is_absolute() {
                    target
                } else {
                    destination
                        .parent()
                        .filter(|parent| !parent.as_os_str().is_empty())
                        .unwrap_or_else(|| Path::new("."))
                        .join(target)
                };
            }
            Ok(_) => return Ok(destination),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(destination),
            Err(error) => {
                return Err(format!("failed to inspect destination file: {error}"));
            }
        }
    }
    Err("failed to resolve destination symlink: too many symbolic links".to_string())
}

fn temporary_path(path: &Path) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("tmp");
    path.with_extension(format!("{extension}.tmp-{}", uuid::Uuid::new_v4()))
}

#[cfg(not(target_os = "windows"))]
fn replace_with_retry(
    source: &Path,
    destination: &Path,
    expected_sha256: Option<&str>,
) -> io::Result<bool> {
    if let Some(expected_sha256) = expected_sha256 {
        if !destination_matches(destination, expected_sha256)? {
            return Ok(false);
        }
    }
    std::fs::rename(source, destination).map(|_| true)
}

#[cfg(target_os = "windows")]
fn replace_with_retry(
    source: &Path,
    destination: &Path,
    expected_sha256: Option<&str>,
) -> io::Result<bool> {
    let mut result = replace_windows_guarded(source, destination, expected_sha256);
    for delay in WINDOWS_RETRY_DELAYS {
        let should_retry = result
            .as_ref()
            .err()
            .is_some_and(is_transient_windows_replace_error);
        if !should_retry {
            break;
        }
        std::thread::sleep(delay);
        result = replace_windows_guarded(source, destination, expected_sha256);
    }
    result
}

#[cfg(target_os = "windows")]
fn is_transient_windows_replace_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33))
}

#[cfg(target_os = "windows")]
fn replace_windows_guarded(
    source: &Path,
    destination: &Path,
    expected_sha256: Option<&str>,
) -> io::Result<bool> {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ};

    let _destination_guard = if let Some(expected_sha256) = expected_sha256 {
        let mut file = match OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(destination)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let mut current = Vec::new();
        file.read_to_end(&mut current)?;
        if sha256_hex(&current) != expected_sha256 {
            return Ok(false);
        }
        Some(file)
    } else {
        None
    };

    if expected_sha256.is_some() {
        // MoveFileExW rejects the still-open digest guard. ReplaceFileW can replace
        // the guarded path and also carries its metadata onto the temporary file.
        replace_windows_preserving_destination(source, destination).map(|_| true)
    } else {
        replace_windows(source, destination).map(|_| true)
    }
}

#[cfg(target_os = "windows")]
fn replace_windows_preserving_destination(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    // Pass a backup name so ERROR_UNABLE_TO_MOVE_REPLACEMENT (1176) keeps both
    // the replaced and replacement files under their original names. Without a
    // backup, Windows deletes the destination on that failure and leaves only
    // the temp file — which callers must not then discard.
    let backup = temporary_path(destination);
    let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
    source_wide.push(0);
    let mut destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
    destination_wide.push(0);
    let mut backup_wide: Vec<u16> = backup.as_os_str().encode_wide().collect();
    backup_wide.push(0);
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            source_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        let error = io::Error::last_os_error();
        restore_replace_backup_for_error(&backup, destination, error.raw_os_error());
        return Err(error);
    }
    let _ = std::fs::remove_file(&backup);
    Ok(())
}

/// Restore destination credentials after a failed ReplaceFileW that moved the
/// original file to the backup path (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 / 1177).
fn restore_replace_backup_for_error(backup: &Path, destination: &Path, raw_os_error: Option<i32>) {
    const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;
    match raw_os_error {
        Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) => {
            if backup.exists() && !destination.exists() {
                let _ = std::fs::rename(backup, destination);
            } else {
                let _ = std::fs::remove_file(backup);
            }
        }
        _ => {
            // 1175/1176 (with backup) and other errors keep both original names.
            let _ = std::fs::remove_file(backup);
        }
    }
}

#[cfg(target_os = "windows")]
fn replace_windows(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
    source_wide.push(0);
    let mut destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
    destination_wide.push(0);
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_writes_replace_existing_content() {
        let dir =
            std::env::temp_dir().join(format!("openusage-safe-file-{}", uuid::Uuid::new_v4()));
        let path = dir.join("settings.json");
        write_text(&path, "one").expect("first write");
        write_text(&path, "two").expect("replacement write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn conditional_write_preserves_content_after_a_digest_change() {
        let dir = std::env::temp_dir().join(format!(
            "openusage-safe-file-conditional-{}",
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("auth.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "original").unwrap();
        let original_digest = sha256_hex(b"original");

        assert!(write_text_if_unchanged(&path, "first", &original_digest).unwrap());
        assert!(!write_text_if_unchanged(&path, "stale", &original_digest).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn relative_destination_does_not_require_a_parent_directory() {
        let filename = format!("openusage-safe-file-{}.json", uuid::Uuid::new_v4());
        let path = Path::new(&filename);
        write_text(path, "relative").expect("write relative file");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "relative");
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink_without_replacing_the_link() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("openusage-safe-symlink-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("auth-target.json");
        let link = dir.join("auth.json");
        std::fs::write(&target, "old").unwrap();
        symlink("auth-target.json", &link).unwrap();

        let original_digest = sha256_hex(b"old");
        assert!(
            write_text_if_unchanged(&link, "new", &original_digest)
                .expect("conditional write through symlink")
        );
        write_text(&link, "newer").expect("write through symlink");

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "newer");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_write_cleanup_promotes_temp_when_destination_is_gone() {
        let dir = std::env::temp_dir().join(format!(
            "openusage-safe-recover-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let destination = dir.join("auth.json");
        let temp = dir.join("auth.json.tmp-orphaned");
        std::fs::write(&temp, r#"{"access_token":"rotated"}"#).unwrap();

        assert_eq!(
            cleanup_temp_after_failed_write(&temp, &destination),
            TempCleanupOutcome::Recovered
        );
        assert!(!temp.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            r#"{"access_token":"rotated"}"#
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_write_cleanup_discards_temp_when_destination_survives() {
        let dir = std::env::temp_dir().join(format!(
            "openusage-safe-discard-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let destination = dir.join("auth.json");
        let temp = dir.join("auth.json.tmp-unused");
        std::fs::write(&destination, r#"{"access_token":"current"}"#).unwrap();
        std::fs::write(&temp, r#"{"access_token":"stale"}"#).unwrap();

        assert_eq!(
            cleanup_temp_after_failed_write(&temp, &destination),
            TempCleanupOutcome::Removed
        );
        assert!(!temp.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            r#"{"access_token":"current"}"#
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn replace_backup_restore_returns_original_on_unable_to_move_replacement_2() {
        let dir = std::env::temp_dir().join(format!(
            "openusage-safe-backup-1177-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let destination = dir.join("auth.json");
        let backup = dir.join("auth.json.bak");
        std::fs::write(&backup, r#"{"access_token":"original"}"#).unwrap();

        restore_replace_backup_for_error(&backup, &destination, Some(1177));

        assert!(!backup.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            r#"{"access_token":"original"}"#
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn replace_backup_cleanup_keeps_destination_on_unable_to_move_replacement() {
        let dir = std::env::temp_dir().join(format!(
            "openusage-safe-backup-1176-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let destination = dir.join("auth.json");
        let backup = dir.join("auth.json.bak");
        std::fs::write(&destination, r#"{"access_token":"original"}"#).unwrap();
        std::fs::write(&backup, "unused").unwrap();

        restore_replace_backup_for_error(&backup, &destination, Some(1176));

        assert!(!backup.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            r#"{"access_token":"original"}"#
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
