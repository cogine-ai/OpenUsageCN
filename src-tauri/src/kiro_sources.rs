//! Read-only identity of Kiro's selected credential source, never its usage cache or logs.
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_CREDENTIAL_BYTES: u64 = 128 * 1024;
const TOKEN: &str = ".aws/sso/cache/kiro-auth-token.json";
const PROFILE: &str =
    "Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json";

pub(crate) struct Source {
    pub fingerprint: String,
    pub environment: HashMap<String, Option<String>>,
}

#[cfg(test)]
pub(crate) fn test_home() -> PathBuf {
    // Cache and runtime tests must never resolve a developer's actual HOME or shell.
    static HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        std::env::temp_dir().join(format!(
            "openusage-kiro-source-test-{}",
            uuid::Uuid::new_v4()
        ))
    })
    .clone()
}

pub(crate) fn snapshot() -> Result<Source, String> {
    #[cfg(test)]
    {
        let home = test_home();
        snapshot_at(&home, std::env::consts::OS, |names| {
            Ok(names
                .iter()
                .map(|name| ((*name).to_owned(), None))
                .collect())
        })
    }
    #[cfg(not(test))]
    {
        let home = dirs::home_dir().ok_or_else(|| failure("home directory unavailable"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        snapshot_at(&home, std::env::consts::OS, |names| {
            let resolved =
                crate::plugin_engine::host_api::resolve_env_values_before(names, deadline);
            if !resolved.unresolved.is_empty() {
                return Err(failure("environment source unresolved"));
            }
            Ok(resolved.values)
        })
    }
}

fn failure(reason: &str) -> String {
    log::warn!("Kiro credential source could not be verified: {reason}");
    "Could not verify Kiro sign-in source. Check file access and refresh usage.".into()
}

/// The injected directory and resolver keep tests independent of the host's credentials.
fn snapshot_at(
    home: &Path,
    platform: &str,
    resolve: impl Fn(&[&str]) -> Result<HashMap<String, Option<String>>, String>,
) -> Result<Source, String> {
    let token_path = home.join(TOKEN);
    // symlink_metadata distinguishes a missing path from an existing broken credential link.
    if existing_metadata(&token_path)?.is_some() {
        let token = content_hash(&token_path)?;
        let profile_path = home.join(PROFILE);
        let profile = if existing_metadata(&profile_path)?.is_some() {
            Some(content_hash(&profile_path)?)
        } else {
            None
        };
        return source(
            "desktop",
            &token_path,
            BTreeMap::new(),
            &(token, profile_path, profile),
        );
    }

    let mut environment = resolve(&["KIRO_DATA_DIR"])?;
    let override_dir = clean_path(environment.get("KIRO_DATA_DIR").and_then(Option::as_deref))?;
    let database = if let Some(directory) = override_dir {
        expand_directory(home, directory)?.join("data.sqlite3")
    } else if platform == "macos" || platform == "darwin" {
        home.join("Library/Application Support/kiro-cli/data.sqlite3")
    } else {
        let xdg = resolve(&["XDG_DATA_HOME"])?;
        let selected = clean_path(xdg.get("XDG_DATA_HOME").and_then(Option::as_deref))?;
        let directory = selected
            .map(|path| expand_directory(home, path))
            .transpose()?
            .unwrap_or_else(|| home.join(".local/share"));
        environment.extend(xdg);
        directory.join("kiro-cli/data.sqlite3")
    };
    let database_state = metadata_stamp(&database)?;
    let mut wal_path = database.as_os_str().to_os_string();
    wal_path.push("-wal");
    let wal_state = metadata_stamp(Path::new(&wal_path))?;
    let kind = if database_state.is_some() {
        "cli"
    } else {
        "missing"
    };
    source(
        kind,
        &database,
        environment.into_iter().collect(),
        &(database_state, wal_state),
    )
}

fn source(
    kind: &str,
    path: &Path,
    environment: BTreeMap<String, Option<String>>,
    identity: &impl Serialize,
) -> Result<Source, String> {
    let encoded = serde_json::to_vec(&("kiro-source-v1", kind, path, &environment, identity))
        .map_err(|_| failure("source encoding failed"))?;
    Ok(Source {
        fingerprint: crate::safe_file::sha256_hex(&encoded),
        environment: environment.into_iter().collect(),
    })
}

fn clean_path(value: Option<&str>) -> Result<Option<&str>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.chars().any(char::is_control) {
        return Err(failure("invalid data directory"));
    }
    let value = value.trim();
    Ok((!value.is_empty()).then_some(value))
}

fn expand_directory(home: &Path, directory: &str) -> Result<PathBuf, String> {
    let path = if directory == "~" {
        home.to_path_buf()
    } else if let Some(relative) = directory.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(directory)
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()
            .map_err(|_| failure("working directory unavailable"))?
            .join(path))
    }
}

fn existing_metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(failure("credential path is inaccessible")),
    }
}

fn content_hash(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|_| failure("credential file is inaccessible"))?;
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
        return Err(failure("credential file is not a bounded regular file"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replacement FIFO must not turn this read-only metadata operation into a blocking open.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .map_err(|_| failure("credential file read failed"))?;
    if !file
        .metadata()
        .map_err(|_| failure("credential file metadata failed"))?
        .is_file()
    {
        return Err(failure("credential file is not regular"));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_CREDENTIAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("credential file read failed"))?;
    if bytes.len() as u64 > MAX_CREDENTIAL_BYTES {
        return Err(failure("credential file exceeds its read limit"));
    }
    let fingerprint = crate::safe_file::sha256_hex(&bytes);
    bytes.fill(0);
    Ok(fingerprint)
}

#[derive(Serialize)]
struct Stamp {
    length: u64,
    modified_ns: i128,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}
fn timestamp(value: SystemTime) -> i128 {
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    }
}
fn metadata_stamp(path: &Path) -> Result<Option<Stamp>, String> {
    if existing_metadata(path)?.is_none() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(path).map_err(|_| failure("CLI database metadata is inaccessible"))?;
    if !metadata.is_file() {
        return Err(failure("CLI database path is not a regular file"));
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(Some(Stamp {
        length: metadata.len(),
        modified_ns: timestamp(
            metadata
                .modified()
                .map_err(|_| failure("CLI database modification time is unavailable"))?,
        ),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        changed_seconds: metadata.ctime(),
        #[cfg(unix)]
        changed_nanoseconds: metadata.ctime_nsec(),
    }))
}

#[cfg(test)]
#[path = "kiro_sources_tests.rs"]
mod tests;
