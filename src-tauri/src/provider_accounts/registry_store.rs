use super::state::{AccountRecord, ProviderState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

const REGISTRY_FILE_NAME: &str = "provider-accounts.json";
const REGISTRY_LOCK_FILE_NAME: &str = ".provider-accounts.lock";

#[derive(Clone)]
pub(super) struct RegistryStore {
    app_data_dir: PathBuf,
}

pub(super) struct LockedProviderState {
    _lock_file: std::fs::File,
    provider: Option<ProviderState>,
}

impl LockedProviderState {
    pub(super) fn provider(&self) -> Option<&ProviderState> {
        self.provider.as_ref()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    version: u32,
    revision: u64,
    providers: HashMap<String, ProviderState>,
}

impl RegistryFile {
    fn empty() -> Self {
        Self {
            version: 1,
            revision: 0,
            providers: HashMap::new(),
        }
    }
}

impl RegistryStore {
    pub(super) fn new(app_data_dir: &Path) -> Self {
        Self {
            app_data_dir: app_data_dir.to_path_buf(),
        }
    }

    pub(super) fn load_providers(&self) -> Result<HashMap<String, ProviderState>, String> {
        Ok(self.load_registry()?.providers)
    }

    pub(super) fn registry_exists(&self) -> Result<bool, String> {
        match std::fs::metadata(self.app_data_dir.join(REGISTRY_FILE_NAME)) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("provider account storage could not be inspected".to_string()),
        }
    }

    pub(super) fn save_provider(
        &self,
        provider_id: &str,
        incoming: &ProviderState,
    ) -> Result<ProviderState, String> {
        std::fs::create_dir_all(&self.app_data_dir)
            .map_err(|_| "provider account storage directory could not be created".to_string())?;
        let lock_path = self.app_data_dir.join(REGISTRY_LOCK_FILE_NAME);
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|_| "provider account storage lock could not be opened".to_string())?;
        lock_registry_file(&lock_file)?;

        let mut registry = self.load_registry()?;
        let merged = registry
            .providers
            .remove(provider_id)
            .map(|stored| merge_provider(stored, incoming.clone()))
            .unwrap_or_else(|| incoming.clone());
        registry
            .providers
            .insert(provider_id.to_string(), merged.clone());
        registry.revision = registry
            .revision
            .checked_add(1)
            .ok_or_else(|| "provider account storage revision is exhausted".to_string())?;
        let json = serde_json::to_string(&registry)
            .map_err(|_| "provider account storage could not be serialized".to_string())?;
        crate::safe_file::write_text(&self.app_data_dir.join(REGISTRY_FILE_NAME), &json)
            .map_err(|_| "provider account storage could not be saved".to_string())?;
        Ok(merged)
    }

    pub(super) fn lock_provider(&self, provider_id: &str) -> Result<LockedProviderState, String> {
        std::fs::create_dir_all(&self.app_data_dir)
            .map_err(|_| "provider account storage directory could not be created".to_string())?;
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.app_data_dir.join(REGISTRY_LOCK_FILE_NAME))
            .map_err(|_| "provider account storage lock could not be opened".to_string())?;
        lock_registry_file(&lock_file)?;
        let provider = self.load_registry()?.providers.remove(provider_id);
        Ok(LockedProviderState {
            _lock_file: lock_file,
            provider,
        })
    }

    fn load_registry(&self) -> Result<RegistryFile, String> {
        let path = self.app_data_dir.join(REGISTRY_FILE_NAME);
        let data = match std::fs::read_to_string(path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RegistryFile::empty());
            }
            Err(_) => return Err("provider account storage could not be read".to_string()),
        };
        let registry: RegistryFile = serde_json::from_str(&data)
            .map_err(|_| "provider account storage is damaged".to_string())?;
        if registry.version != 1 {
            return Err("provider account storage has an unsupported version".to_string());
        }
        Ok(registry)
    }
}

fn merge_provider(mut stored: ProviderState, incoming: ProviderState) -> ProviderState {
    let incoming_selection_wins = incoming.selection_revision >= stored.selection_revision;
    for incoming_account in incoming.accounts {
        if let Some(stored_account) = stored.accounts.iter_mut().find(|account| {
            account.account_id == incoming_account.account_id
                || account.identity_fingerprint == incoming_account.identity_fingerprint
        }) {
            merge_account(stored_account, incoming_account);
        } else {
            stored.accounts.push(incoming_account);
        }
    }
    if incoming_selection_wins {
        stored.selection = incoming.selection;
        stored.selection_revision = incoming.selection_revision;
        stored.active_account_id = incoming.active_account_id;
    }
    if incoming.default_account_id.is_some() {
        stored.default_account_id = incoming.default_account_id;
    }
    stored
}

fn merge_account(stored: &mut AccountRecord, incoming: AccountRecord) {
    if incoming.label_revision >= stored.label_revision {
        stored.label = incoming.label;
        stored.label_revision = incoming.label_revision;
    }
    stored.identity_namespace = incoming.identity_namespace;
    for connection in incoming.connections {
        if let Some(current) = stored.connections.iter_mut().find(|current| {
            current.connection_id == connection.connection_id
                || (current.kind == connection.kind
                    && current.connection_key == connection.connection_key)
        }) {
            if connection.attachment_revision >= current.attachment_revision {
                current.attached = connection.attached;
                current.attachment_revision = connection.attachment_revision;
                current.available = connection.available;
                if connection.session_ref.is_some() {
                    current.session_ref = connection.session_ref;
                } else if !connection.attached {
                    current.session_ref = None;
                }
            }
        } else {
            stored.connections.push(connection);
        }
    }
}

#[cfg(unix)]
fn lock_registry_file(file: &std::fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err("provider account storage lock could not be acquired".to_string())
    }
}

#[cfg(not(unix))]
fn lock_registry_file(_file: &std::fs::File) -> Result<(), String> {
    Ok(())
}
