use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use super::{CompleteHistory, HistoryError};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryDocument {
    version: u32,
    history: CompleteHistory,
}

const HISTORY_LOCK_FILE_NAME: &str = ".history.lock";

#[derive(Clone)]
pub(crate) struct HistoryStore {
    root: PathBuf,
}

impl HistoryStore {
    pub(crate) fn new(app_data_dir: &Path) -> Self {
        Self {
            root: app_data_dir.join("provider-history"),
        }
    }

    pub(crate) fn load(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<Option<CompleteHistory>, HistoryError> {
        let path = self.document_path(provider_id, account_id)?;
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(HistoryError::StorageRead),
        };
        let document: HistoryDocument =
            serde_json::from_str(&content).map_err(|_| HistoryError::StorageInvalid)?;
        if document.version != 1 {
            return Err(HistoryError::StorageInvalid);
        }
        let history = document.history;
        if !history.coverage.complete || history.account_id != account_id {
            return Err(HistoryError::StorageInvalid);
        }
        Ok(Some(history))
    }

    pub(crate) fn save(
        &self,
        provider_id: &str,
        account_id: &str,
        history: &CompleteHistory,
    ) -> Result<(), HistoryError> {
        if !history.coverage.complete {
            return Err(HistoryError::IncompleteSnapshot);
        }
        if history.account_id != account_id {
            return Err(HistoryError::SnapshotAccountMismatch);
        }
        std::fs::create_dir_all(&self.root).map_err(|_| HistoryError::StorageWrite)?;
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.root.join(HISTORY_LOCK_FILE_NAME))
            .map_err(|_| HistoryError::StorageWrite)?;
        lock_history_file(&lock_file)?;
        if self
            .load(provider_id, account_id)?
            .is_some_and(|stored| !history_is_at_least_as_new(history, &stored))
        {
            return Ok(());
        }
        let path = self.document_path(provider_id, account_id)?;
        let content = serde_json::to_string(&HistoryDocument {
            version: 1,
            history: history.clone(),
        })
        .map_err(|_| HistoryError::StorageWrite)?;
        crate::safe_file::write_text(&path, &content).map_err(|_| HistoryError::StorageWrite)
    }

    pub(super) fn document_path(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<PathBuf, HistoryError> {
        if !valid_component(provider_id) || !valid_component(account_id) {
            return Err(HistoryError::InvalidStorageKey);
        }
        Ok(self
            .root
            .join(provider_id)
            .join(format!("{account_id}.json")))
    }
}

fn history_is_at_least_as_new(incoming: &CompleteHistory, stored: &CompleteHistory) -> bool {
    incoming.coverage.fetched_at_ms > stored.coverage.fetched_at_ms
        || (incoming.coverage.fetched_at_ms == stored.coverage.fetched_at_ms
            && incoming.coverage.to_ms >= stored.coverage.to_ms)
}

#[cfg(unix)]
fn lock_history_file(file: &std::fs::File) -> Result<(), HistoryError> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err(HistoryError::StorageWrite)
    }
}

#[cfg(not(unix))]
fn lock_history_file(_file: &std::fs::File) -> Result<(), HistoryError> {
    Ok(())
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}
