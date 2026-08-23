use super::keychain::{InstallationKeyStore, SystemInstallationKeyStore};
use super::model::{
    AccountId, OperationStatus, ProviderAccountViewChanged, ProviderEnrichmentWarning,
    ProviderOperationReceipt, ProviderPersistenceWarning,
};
use super::probe::ProviderAccountAdapter;
use super::registry_store::RegistryStore;
use super::snapshot_store::SnapshotStore;
use super::state::ProviderState;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) struct ProviderAccounts {
    pub(super) installation_key: Mutex<Option<[u8; 32]>>,
    pub(super) installation_key_store: Option<Arc<dyn InstallationKeyStore>>,
    pub(super) providers: Mutex<HashMap<String, ProviderState>>,
    pub(super) adapters: Mutex<HashMap<String, Arc<dyn ProviderAccountAdapter>>>,
    pub(super) operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub(super) browser_broker: Mutex<Option<Arc<crate::browser_sessions::BrowserSessionBroker>>>,
    pub(super) registry_store: Option<RegistryStore>,
    pub(super) snapshot_store: Option<SnapshotStore>,
    pub(super) persistence_warning: Mutex<Option<ProviderPersistenceWarning>>,
    pub(super) enrichment_warnings: Mutex<HashMap<(String, AccountId), ProviderEnrichmentWarning>>,
    revision: AtomicU64,
}

impl ProviderAccounts {
    #[cfg(test)]
    pub(crate) fn in_memory(installation_key: [u8; 32]) -> Self {
        Self {
            installation_key: Mutex::new(Some(installation_key)),
            installation_key_store: None,
            providers: Mutex::new(HashMap::new()),
            adapters: Mutex::new(HashMap::new()),
            operation_locks: Mutex::new(HashMap::new()),
            browser_broker: Mutex::new(None),
            registry_store: None,
            snapshot_store: None,
            persistence_warning: Mutex::new(None),
            enrichment_warnings: Mutex::new(HashMap::new()),
            revision: AtomicU64::new(0),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_store(
        installation_key: [u8; 32],
        app_data_dir: &Path,
    ) -> Result<Self, String> {
        let registry_store = RegistryStore::new(app_data_dir);
        let providers = registry_store.load_providers()?;
        Ok(Self {
            installation_key: Mutex::new(Some(installation_key)),
            installation_key_store: None,
            providers: Mutex::new(providers),
            adapters: Mutex::new(HashMap::new()),
            operation_locks: Mutex::new(HashMap::new()),
            browser_broker: Mutex::new(None),
            registry_store: Some(registry_store),
            snapshot_store: Some(SnapshotStore::new(app_data_dir)),
            persistence_warning: Mutex::new(None),
            enrichment_warnings: Mutex::new(HashMap::new()),
            revision: AtomicU64::new(0),
        })
    }

    pub(crate) fn open(app_data_dir: &Path) -> Result<Self, String> {
        Self::open_with_key_store_internal(
            app_data_dir,
            Arc::new(SystemInstallationKeyStore::new()),
        )
    }

    #[cfg(test)]
    pub(crate) fn open_with_key_store(
        app_data_dir: &Path,
        installation_key_store: Arc<dyn InstallationKeyStore>,
    ) -> Result<Self, String> {
        Self::open_with_key_store_internal(app_data_dir, installation_key_store)
    }

    fn open_with_key_store_internal(
        app_data_dir: &Path,
        installation_key_store: Arc<dyn InstallationKeyStore>,
    ) -> Result<Self, String> {
        let registry_store = RegistryStore::new(app_data_dir);
        let providers = registry_store.load_providers()?;
        Ok(Self {
            installation_key: Mutex::new(None),
            installation_key_store: Some(installation_key_store),
            providers: Mutex::new(providers),
            adapters: Mutex::new(HashMap::new()),
            operation_locks: Mutex::new(HashMap::new()),
            browser_broker: Mutex::new(None),
            registry_store: Some(registry_store),
            snapshot_store: Some(SnapshotStore::new(app_data_dir)),
            persistence_warning: Mutex::new(None),
            enrichment_warnings: Mutex::new(HashMap::new()),
            revision: AtomicU64::new(0),
        })
    }

    pub(crate) fn unavailable(error: &str) -> Self {
        let correlation_id = uuid::Uuid::new_v4().to_string();
        log::error!(
            "provider account storage unavailable: correlation_id={}, reason={}",
            correlation_id,
            error
        );
        Self {
            installation_key: Mutex::new(None),
            installation_key_store: None,
            providers: Mutex::new(HashMap::new()),
            adapters: Mutex::new(HashMap::new()),
            operation_locks: Mutex::new(HashMap::new()),
            browser_broker: Mutex::new(None),
            registry_store: None,
            snapshot_store: None,
            persistence_warning: Mutex::new(Some(ProviderPersistenceWarning {
                code: "persistenceUnavailable".to_string(),
                message: "Account data is unavailable. Restore storage access and restart the app."
                    .to_string(),
                correlation_id,
            })),
            enrichment_warnings: Mutex::new(HashMap::new()),
            revision: AtomicU64::new(0),
        }
    }

    pub(crate) fn register_adapter(
        &self,
        provider_id: &str,
        adapter: Box<dyn ProviderAccountAdapter>,
    ) {
        self.adapters
            .lock()
            .expect("provider account adapters poisoned")
            .insert(provider_id.to_string(), Arc::from(adapter));
    }

    pub(crate) fn set_browser_broker(
        &self,
        broker: Arc<crate::browser_sessions::BrowserSessionBroker>,
    ) {
        *self
            .browser_broker
            .lock()
            .expect("provider account browser broker poisoned") = Some(broker);
    }

    pub(crate) fn changed_event(
        &self,
        provider_id: &str,
        receipt: &ProviderOperationReceipt,
    ) -> Option<ProviderAccountViewChanged> {
        if receipt.status == OperationStatus::Failed {
            return None;
        }
        Some(self.view_changed_event(provider_id))
    }

    pub(crate) fn view_changed_event(&self, provider_id: &str) -> ProviderAccountViewChanged {
        ProviderAccountViewChanged {
            provider_id: provider_id.to_string(),
            revision: self.revision.fetch_add(1, Ordering::Relaxed) + 1,
        }
    }

    pub(super) fn current_persistence_warning(&self) -> Option<ProviderPersistenceWarning> {
        self.persistence_warning
            .lock()
            .map(|warning| warning.clone())
            .unwrap_or_else(|_| {
                Some(ProviderPersistenceWarning {
                    code: "persistenceUnavailable".to_string(),
                    message:
                        "Account data is unavailable. Restore storage access and restart the app."
                            .to_string(),
                    correlation_id: "provider-account-warning-unavailable".to_string(),
                })
            })
    }

    pub(super) fn current_enrichment_warning(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Option<ProviderEnrichmentWarning> {
        match self.enrichment_warnings.lock() {
            Ok(warnings) => warnings
                .get(&(provider_id.to_string(), account_id.to_string()))
                .cloned(),
            Err(_) => {
                log::error!("provider enrichment warning state is unavailable");
                None
            }
        }
    }

    pub(super) fn record_persistence_failure(&self, reason: &str) {
        let mut warning = match self.persistence_warning.lock() {
            Ok(warning) => warning,
            Err(_) => {
                log::error!("provider account persistence warning state is unavailable");
                return;
            }
        };
        let correlation_id = warning
            .get_or_insert_with(|| ProviderPersistenceWarning {
                code: "persistenceUnavailable".to_string(),
                message: "Account changes cannot be saved. Restore Keychain access and try again."
                    .to_string(),
                correlation_id: uuid::Uuid::new_v4().to_string(),
            })
            .correlation_id
            .clone();
        log::error!(
            "provider account persistence unavailable: correlation_id={}, reason={}",
            correlation_id,
            reason
        );
    }
}
