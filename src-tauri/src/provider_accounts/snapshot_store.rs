use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

const SNAPSHOT_FILE_NAME: &str = "provider-account-snapshots.json";
const SNAPSHOT_LOCK_FILE_NAME: &str = ".provider-account-snapshots.lock";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountSnapshot {
    pub(super) display_name: String,
    pub(super) plan: Option<String>,
    pub(super) lines: Vec<MetricLine>,
    pub(super) started_at: String,
    pub(super) fetched_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    version: u32,
    providers: HashMap<String, HashMap<String, AccountSnapshot>>,
}

impl SnapshotFile {
    fn empty() -> Self {
        Self {
            version: 1,
            providers: HashMap::new(),
        }
    }
}

#[derive(Clone)]
pub(super) struct SnapshotStore {
    app_data_dir: PathBuf,
}

impl SnapshotStore {
    pub(super) fn new(app_data_dir: &Path) -> Self {
        Self {
            app_data_dir: app_data_dir.to_path_buf(),
        }
    }

    pub(super) fn load(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<Option<AccountSnapshot>, String> {
        Ok(self
            .load_file()?
            .providers
            .get(provider_id)
            .and_then(|accounts| accounts.get(account_id))
            .cloned())
    }

    pub(super) fn save(
        &self,
        provider_id: &str,
        account_id: &str,
        output: &PluginOutput,
        started_at: &str,
        fetched_at: &str,
    ) -> Result<bool, String> {
        if provider_id.trim().is_empty()
            || account_id.trim().is_empty()
            || output.provider_id != provider_id
            || parse_timestamp(started_at).is_err()
            || parse_timestamp(fetched_at).is_err()
        {
            return Err("provider account snapshot is invalid".to_string());
        }

        std::fs::create_dir_all(&self.app_data_dir)
            .map_err(|_| "provider account snapshot directory could not be created".to_string())?;
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.app_data_dir.join(SNAPSHOT_LOCK_FILE_NAME))
            .map_err(|_| "provider account snapshot lock could not be opened".to_string())?;
        lock_snapshot_file(&lock_file)?;

        let mut file = self.load_file()?;
        let accounts = file.providers.entry(provider_id.to_string()).or_default();
        let incoming = AccountSnapshot {
            display_name: output.display_name.clone(),
            plan: output.plan.clone(),
            lines: output.lines.clone(),
            started_at: started_at.to_string(),
            fetched_at: fetched_at.to_string(),
        };
        if accounts
            .get(account_id)
            .is_some_and(|stored| !snapshot_is_at_least_as_new(&incoming, stored))
        {
            return Ok(false);
        }
        accounts.insert(account_id.to_string(), incoming);
        let json = serde_json::to_string(&file)
            .map_err(|_| "provider account snapshots could not be serialized".to_string())?;
        crate::safe_file::write_text(&self.app_data_dir.join(SNAPSHOT_FILE_NAME), &json)
            .map_err(|_| "provider account snapshots could not be saved".to_string())?;
        Ok(true)
    }

    fn load_file(&self) -> Result<SnapshotFile, String> {
        let data = match std::fs::read_to_string(self.app_data_dir.join(SNAPSHOT_FILE_NAME)) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SnapshotFile::empty());
            }
            Err(_) => {
                return Err("provider account snapshot storage could not be read".to_string());
            }
        };
        let file: SnapshotFile = serde_json::from_str(&data)
            .map_err(|_| "provider account snapshot storage is damaged".to_string())?;
        if file.version != 1 {
            return Err("provider account snapshot storage has an unsupported version".to_string());
        }
        Ok(file)
    }
}

fn snapshot_is_at_least_as_new(incoming: &AccountSnapshot, stored: &AccountSnapshot) -> bool {
    match (
        parse_timestamp(&incoming.started_at),
        parse_timestamp(&stored.started_at),
    ) {
        (Ok(incoming_at), Ok(stored_at)) if incoming_at != stored_at => incoming_at > stored_at,
        (Ok(_), Ok(_)) => match (
            parse_timestamp(&incoming.fetched_at),
            parse_timestamp(&stored.fetched_at),
        ) {
            (Ok(incoming_at), Ok(stored_at)) => incoming_at >= stored_at,
            (Ok(_), Err(_)) => true,
            _ => false,
        },
        (Ok(_), Err(_)) => true,
        _ => false,
    }
}

fn parse_timestamp(value: &str) -> Result<time::OffsetDateTime, time::error::Parse> {
    time::OffsetDateTime::parse(value.trim(), &time::format_description::well_known::Rfc3339)
}

#[cfg(unix)]
fn lock_snapshot_file(file: &std::fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err("provider account snapshot lock could not be acquired".to_string())
    }
}

#[cfg(not(unix))]
fn lock_snapshot_file(_file: &std::fs::File) -> Result<(), String> {
    Ok(())
}
