use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use super::{CompleteHistory, HistoryError};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryDocument {
    version: u32,
    history: CompleteHistory,
    #[serde(default)]
    archived: Option<Vec<CompleteHistory>>,
}

const HISTORY_LOCK_FILE_NAME: &str = ".history.lock";
const MAX_RECORDED_WINDOWS: usize = 12;

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
        Ok(self
            .read_document(provider_id, account_id)?
            .map(|document| document.history))
    }

    fn read_document(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<Option<HistoryDocument>, HistoryError> {
        let path = self.document_path(provider_id, account_id)?;
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(HistoryError::StorageRead),
        };
        let document: HistoryDocument =
            serde_json::from_str(&content).map_err(|_| HistoryError::StorageInvalid)?;
        if !matches!(document.version, 1 | 2)
            || (document.version == 2 && document.archived.is_none())
            || (document.version == 1 && document.archived.is_some())
        {
            return Err(HistoryError::StorageInvalid);
        }
        let histories: Vec<_> = std::iter::once(&document.history)
            .chain(document.archived.iter().flatten())
            .collect();
        if histories.len() > MAX_RECORDED_WINDOWS
            || histories
                .iter()
                .any(|history| !valid_history(history, account_id))
            || histories.iter().enumerate().any(|(index, history)| {
                histories[..index]
                    .iter()
                    .any(|previous| same_period(history, previous))
            })
        {
            return Err(HistoryError::StorageInvalid);
        }
        Ok(Some(document))
    }

    pub(crate) fn list(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<Vec<CompleteHistory>, HistoryError> {
        Ok(self
            .read_document(provider_id, account_id)?
            .map_or_else(Vec::new, |document| {
                std::iter::once(document.history)
                    .chain(document.archived.into_iter().flatten())
                    .collect()
            }))
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
        if !valid_history(history, account_id) {
            return Err(HistoryError::StorageInvalid);
        }
        std::fs::create_dir_all(&self.root).map_err(|_| HistoryError::StorageWrite)?;
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.root.join(HISTORY_LOCK_FILE_NAME))
            .map_err(|_| HistoryError::StorageWrite)?;
        lock_history_file(&lock_file)?;
        let mut archived = self.list(provider_id, account_id)?;
        if archived
            .first()
            .is_some_and(|stored| !history_is_at_least_as_new(history, stored))
        {
            return Ok(());
        }
        // A refresh replaces the whole recorded window; overlapping events are never added.
        archived.retain(|stored| !same_period(history, stored));
        archived.truncate(MAX_RECORDED_WINDOWS - 1);
        let path = self.document_path(provider_id, account_id)?;
        let content = serde_json::to_string(&HistoryDocument {
            version: 2,
            history: history.clone(),
            archived: Some(archived),
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

fn same_period(left: &CompleteHistory, right: &CompleteHistory) -> bool {
    match (&left.coverage.billing_cycle, &right.coverage.billing_cycle) {
        (Some(left), Some(right)) => left == right,
        (None, None) => {
            left.coverage.from_ms == right.coverage.from_ms
                && left.coverage.to_ms == right.coverage.to_ms
                && left.coverage.time_zone == right.coverage.time_zone
                && left.coverage.scope == right.coverage.scope
        }
        _ => false,
    }
}

fn valid_history(history: &CompleteHistory, account_id: &str) -> bool {
    let coverage = &history.coverage;
    history.account_id == account_id
        && coverage.complete
        && coverage.from_ms > 0
        && coverage.from_ms < coverage.to_ms
        && jiff::tz::TimeZone::get(&coverage.time_zone).is_ok()
        && coverage.billing_cycle.as_ref().is_none_or(|cycle| {
            cycle.start_ms > 0
                && cycle.start_ms <= coverage.from_ms
                && cycle.end_ms >= coverage.to_ms
        })
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
