use super::ProviderAccounts;
use super::keychain::InstallationKeyError;
use super::model::{
    AccountSelection, OperationStatus, ProviderAccountView, ProviderOperation,
    ProviderOperationError, ProviderOperationReceipt,
};
use super::refresh::LocalRefresh;
use super::state::{ProviderState, empty_view, view_from_state};

impl ProviderAccounts {
    /// Reads account state and live display identity without discovering or changing credentials.
    pub(crate) fn view(&self, provider_id: &str) -> Result<ProviderAccountView, String> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?;
        let Some(provider) = providers.get(provider_id) else {
            return Ok(empty_view(provider_id, self.current_persistence_warning()));
        };
        let enrichment_warning = provider
            .active_account_id
            .as_deref()
            .and_then(|account_id| self.current_enrichment_warning(provider_id, account_id));
        let mut view = view_from_state(
            provider_id,
            provider,
            self.current_persistence_warning(),
            enrichment_warning,
        );
        self.add_browser_identity(&mut view, provider)?;
        Ok(view)
    }

    /// Serializes a provider's operations and returns a safe receipt even when mutation fails.
    pub(crate) fn perform(
        &self,
        provider_id: &str,
        operation: ProviderOperation,
    ) -> ProviderOperationReceipt {
        let operation_id = uuid::Uuid::new_v4().to_string();
        let is_refresh = matches!(
            &operation,
            ProviderOperation::RefreshActive | ProviderOperation::RefreshCursorDesktop
        );
        let operation_lock = match self.operation_locks.lock() {
            Ok(mut locks) => locks
                .entry(provider_id.to_string())
                .or_insert_with(|| std::sync::Arc::new(std::sync::Mutex::new(())))
                .clone(),
            Err(_) => {
                log_operation_failure(provider_id, &operation_id);
                return ProviderOperationReceipt {
                    operation_id,
                    status: OperationStatus::Failed,
                    source_outcomes: Vec::new(),
                    view: self.fallback_view(provider_id),
                    error: Some(operation_error(provider_id, is_refresh)),
                };
            }
        };
        let _operation_guard = match operation_lock.lock() {
            Ok(guard) => guard,
            Err(_) => {
                log_operation_failure(provider_id, &operation_id);
                return ProviderOperationReceipt {
                    operation_id,
                    status: OperationStatus::Failed,
                    source_outcomes: Vec::new(),
                    view: self.fallback_view(provider_id),
                    error: Some(operation_error(provider_id, is_refresh)),
                };
            }
        };
        let result = (|| {
            if let Some(store) = &self.registry_store {
                let mut providers = self
                    .providers
                    .lock()
                    .map_err(|_| "provider account state is unavailable")?;
                let current = providers.get(provider_id).cloned().unwrap_or_default();
                providers.insert(
                    provider_id.to_string(),
                    store.refresh_runtime(provider_id, current)?,
                );
            }
            match operation {
                ProviderOperation::RefreshActive => {
                    self.refresh_local(provider_id, LocalRefresh::Active)
                }
                ProviderOperation::RefreshCursorDesktop if provider_id == "cursor" => {
                    self.refresh_local(provider_id, LocalRefresh::CursorDesktop)
                }
                ProviderOperation::RefreshCursorDesktop => {
                    Err("Desktop authorization is only supported for Cursor.".into())
                }
                ProviderOperation::ReconnectLocal => {
                    self.refresh_local(provider_id, LocalRefresh::Reconnect)
                }
                ProviderOperation::RemoveAccount { account_id } => self
                    .remove_account(provider_id, &account_id)
                    .map(|_| (OperationStatus::Succeeded, Vec::new())),
                ProviderOperation::SelectActive { account_id } => self
                    .select_active(provider_id, &account_id)
                    .map(|_| (OperationStatus::Succeeded, Vec::new())),
                ProviderOperation::FollowDefaultConnection if provider_id == "cursor" => {
                    self.refresh_local(provider_id, LocalRefresh::FollowDefault)
                }
                ProviderOperation::FollowDefaultConnection => self
                    .follow_default(provider_id)
                    .map(|_| (OperationStatus::Succeeded, Vec::new())),
                ProviderOperation::RenameAccount { account_id, label } => self
                    .rename_account(provider_id, &account_id, &label)
                    .map(|_| (OperationStatus::Succeeded, Vec::new())),
                ProviderOperation::AttachBrowserCandidate { candidate_id } => {
                    self.attach_browser_candidate(provider_id, &candidate_id)
                }
                ProviderOperation::DetachConnection {
                    account_id,
                    connection_id,
                } => self
                    .detach_browser_connection(provider_id, &account_id, &connection_id)
                    .map(|_| (OperationStatus::Succeeded, Vec::new())),
            }
        })();
        match result {
            Ok((status, source_outcomes)) if status != OperationStatus::Failed => {
                ProviderOperationReceipt {
                    operation_id,
                    status,
                    source_outcomes,
                    view: self.fallback_view(provider_id),
                    error: None,
                }
            }
            Ok((status, source_outcomes)) => {
                log_operation_failure(provider_id, &operation_id);
                ProviderOperationReceipt {
                    operation_id,
                    status,
                    source_outcomes,
                    view: self.fallback_view(provider_id),
                    error: Some(operation_error(provider_id, is_refresh)),
                }
            }
            Err(reason) => {
                log::error!(
                    "provider account operation failed: {}",
                    crate::plugin_engine::host_api::redact_log_message(&reason)
                );
                log_operation_failure(provider_id, &operation_id);
                ProviderOperationReceipt {
                    operation_id,
                    status: OperationStatus::Failed,
                    source_outcomes: Vec::new(),
                    view: self.fallback_view(provider_id),
                    error: Some(operation_error(provider_id, is_refresh)),
                }
            }
        }
    }

    /// Keeps receipts serializable when state cannot be read, preserving any storage warning.
    fn fallback_view(&self, provider_id: &str) -> ProviderAccountView {
        self.view(provider_id)
            .unwrap_or_else(|_| empty_view(provider_id, self.current_persistence_warning()))
    }

    /// Pins an existing account without rediscovery and publishes the persisted selection.
    fn select_active(&self, provider_id: &str, account_id: &str) -> Result<(), String> {
        let mut provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| format!("provider '{provider_id}' has no accounts"))?;
        if !provider
            .accounts
            .iter()
            .any(|account| account.account_id == account_id)
        {
            return Err(format!("account '{account_id}' was not found"));
        }
        provider.selection_revision = provider
            .selection_revision
            .checked_add(1)
            .ok_or_else(|| "account selection revision is exhausted".to_string())?;
        provider.selection = AccountSelection::Pinned(account_id.to_string());
        provider.active_account_id = Some(account_id.to_string());
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)
    }

    /// Restores automatic selection only when a discovered default account exists.
    fn follow_default(&self, provider_id: &str) -> Result<(), String> {
        let mut provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| format!("provider '{provider_id}' has no accounts"))?;
        let default_account_id = provider
            .default_account_id
            .clone()
            .ok_or_else(|| format!("provider '{provider_id}' has no default account"))?;
        provider.selection_revision = provider
            .selection_revision
            .checked_add(1)
            .ok_or_else(|| "account selection revision is exhausted".to_string())?;
        provider.selection = AccountSelection::Auto;
        provider.active_account_id = Some(default_account_id);
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)
    }

    /// Persists a trimmed visible label and increments its revision without changing identity.
    fn rename_account(
        &self,
        provider_id: &str,
        account_id: &str,
        label: &str,
    ) -> Result<(), String> {
        let normalized = label.trim();
        let character_count = normalized.chars().count();
        if !(1..=64).contains(&character_count) || normalized.chars().any(char::is_control) {
            return Err("account label must contain 1 to 64 visible characters".to_string());
        }
        let mut provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| format!("provider '{provider_id}' has no accounts"))?;
        let account = provider
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id)
            .ok_or_else(|| format!("account '{account_id}' was not found"))?;
        account.label = normalized.to_string();
        account.label_revision = account
            .label_revision
            .checked_add(1)
            .ok_or_else(|| "account label revision is exhausted".to_string())?;
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)
    }

    /// Returns the storage-merged state; without a registry store, returns the supplied runtime state.
    pub(super) fn persist_provider(
        &self,
        provider_id: &str,
        provider: &ProviderState,
    ) -> Result<ProviderState, String> {
        match &self.registry_store {
            Some(store) => store.save_provider(provider_id, provider),
            None => Ok(provider.clone()),
        }
    }

    /// Publishes the accepted provider snapshot to runtime state after persistence succeeds.
    pub(super) fn replace_provider_state(
        &self,
        provider_id: &str,
        provider: ProviderState,
    ) -> Result<(), String> {
        self.providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .insert(provider_id.to_string(), provider);
        Ok(())
    }

    /// Reuses the installation key and creates one only when no account registry already exists.
    pub(super) fn resolve_installation_key(&self) -> Result<[u8; 32], String> {
        if let Some(key) = *self
            .installation_key
            .lock()
            .map_err(|_| "provider account installation key is unavailable".to_string())?
        {
            return Ok(key);
        }
        let key_store = self
            .installation_key_store
            .as_ref()
            .ok_or_else(|| "provider account installation key is unavailable".to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let key = match key_store.read(deadline) {
            Ok(key) => key,
            Err(InstallationKeyError::Missing) => {
                let registry_exists = self
                    .registry_store
                    .as_ref()
                    .ok_or_else(|| "provider account storage is unavailable".to_string())?
                    .registry_exists()
                    .map_err(|reason| {
                        self.record_persistence_failure(&reason);
                        reason
                    })?;
                if registry_exists {
                    let reason =
                        "provider account installation key is missing for an existing registry"
                            .to_string();
                    self.record_persistence_failure(&reason);
                    return Err(reason);
                }
                key_store.create(deadline).map_err(|error| {
                    let reason = installation_key_error(error);
                    self.record_persistence_failure(&reason);
                    reason
                })?
            }
            Err(error) => {
                let reason = installation_key_error(error);
                self.record_persistence_failure(&reason);
                return Err(reason);
            }
        }
        .into_bytes();
        *self
            .installation_key
            .lock()
            .map_err(|_| "provider account installation key is unavailable".to_string())? =
            Some(key);
        Ok(key)
    }
}

/// Maps key-storage failures to fixed reasons without exposing operating-system error details.
fn installation_key_error(error: InstallationKeyError) -> String {
    match error {
        InstallationKeyError::Timeout => "provider account installation key access timed out; retry after checking Keychain access",
        InstallationKeyError::Missing => "provider account installation key is missing",
        InstallationKeyError::Denied => "provider account installation key access was denied",
        InstallationKeyError::Unavailable => {
            "provider account installation key storage is unavailable"
        }
        InstallationKeyError::Io => "provider account installation key could not be accessed",
        InstallationKeyError::Invalid => "provider account installation key is invalid",
        InstallationKeyError::Unsupported => {
            "provider account installation key storage is unsupported"
        }
    }
    .to_string()
}

/// Supplies a readable provider name, including a generic name for an empty identifier.
fn provider_display_name(provider_id: &str) -> String {
    let mut characters = provider_id.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => "Provider".to_string(),
    }
}

/// Logs provider and correlation identifiers without account identity or credential contents.
fn log_operation_failure(provider_id: &str, operation_id: &str) {
    log::warn!(
        "provider account operation failed: provider={}, operation_id={}",
        provider_id,
        operation_id
    );
}

/// Produces a fixed recovery message while distinguishing refresh from other account failures.
fn operation_error(provider_id: &str, is_refresh: bool) -> ProviderOperationError {
    ProviderOperationError {
        code: if is_refresh {
            "refreshFailed".to_string()
        } else {
            "operationFailed".to_string()
        },
        message: if is_refresh {
            format!(
                "{} account refresh failed. Try again.",
                provider_display_name(provider_id)
            )
        } else {
            "Account operation failed. Try again.".to_string()
        },
    }
}
