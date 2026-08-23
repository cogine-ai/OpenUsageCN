use super::ProviderAccounts;
use super::identity;
use super::keychain::InstallationKeyError;
use super::model::{
    AccountSelection, OperationStatus, ProviderAccountView, ProviderOperation,
    ProviderOperationError, ProviderOperationReceipt, SourceOutcome, SourceStatus,
};
use super::state::{
    AccountRecord, ConnectionRecord, ProviderState, empty_view, mark_connections_unavailable,
    view_from_state,
};

impl ProviderAccounts {
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
        Ok(view_from_state(
            provider_id,
            provider,
            self.current_persistence_warning(),
            enrichment_warning,
        ))
    }

    pub(crate) fn perform(
        &self,
        provider_id: &str,
        operation: ProviderOperation,
    ) -> ProviderOperationReceipt {
        let operation_id = uuid::Uuid::new_v4().to_string();
        let is_refresh = matches!(&operation, ProviderOperation::RefreshActive);
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
        let result = match operation {
            ProviderOperation::RefreshActive => self.refresh_active(provider_id),
            ProviderOperation::SelectActive { account_id } => self
                .select_active(provider_id, &account_id)
                .map(|_| (OperationStatus::Succeeded, Vec::new())),
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
        };
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
            Err(_) => {
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

    fn fallback_view(&self, provider_id: &str) -> ProviderAccountView {
        self.view(provider_id)
            .unwrap_or_else(|_| empty_view(provider_id, self.current_persistence_warning()))
    }

    fn refresh_active(
        &self,
        provider_id: &str,
    ) -> Result<(OperationStatus, Vec<SourceOutcome>), String> {
        let adapter = self
            .adapters
            .lock()
            .map_err(|_| "provider account adapters are unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| format!("provider '{provider_id}' does not support accounts"))?;
        let report = adapter.discover_default()?;
        if report.observations.is_empty() {
            self.mark_source_outcomes(provider_id, &report.source_outcomes)?;
            return Ok((OperationStatus::Failed, report.source_outcomes));
        }

        for observed in &report.observations {
            if observed.identity_namespace.trim().is_empty()
                || observed.normalized_identity.trim().is_empty()
                || observed.connection_key.trim().is_empty()
            {
                return Err("provider returned an invalid account observation".to_string());
            }
        }
        let installation_key = self.resolve_installation_key()?;
        let mut provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .unwrap_or_default();
        mark_connections_unavailable(&mut provider, &report.source_outcomes);
        let mut default_account_id = None;
        let mut last_observed_account_id = None;
        for observed in report.observations {
            let fingerprint = identity::fingerprint(
                &installation_key,
                provider_id,
                &observed.identity_namespace,
                &observed.normalized_identity,
            );
            let account_index = provider
                .accounts
                .iter()
                .position(|account| account.identity_fingerprint == fingerprint)
                .unwrap_or_else(|| {
                    let account_number = provider.accounts.len() + 1;
                    provider.accounts.push(AccountRecord {
                        account_id: uuid::Uuid::new_v4().to_string(),
                        label: format!("Account {account_number}"),
                        label_revision: 0,
                        identity_namespace: observed.identity_namespace.clone(),
                        identity_fingerprint: fingerprint,
                        connections: Vec::new(),
                    });
                    provider.accounts.len() - 1
                });
            let account = &mut provider.accounts[account_index];
            if let Some(connection) = account.connections.iter_mut().find(|connection| {
                connection.kind == observed.connection_kind
                    && connection.connection_key == observed.connection_key
            }) {
                connection.attached = true;
                connection.available = true;
            } else {
                account.connections.push(ConnectionRecord {
                    connection_id: uuid::Uuid::new_v4().to_string(),
                    connection_key: observed.connection_key.clone(),
                    kind: observed.connection_kind,
                    attached: true,
                    attachment_revision: 0,
                    available: true,
                    session_ref: None,
                });
            }
            if report.default_connection_key.as_deref() == Some(&observed.connection_key) {
                default_account_id = Some(account.account_id.clone());
            }
            last_observed_account_id = Some(account.account_id.clone());
        }
        let observed_account_id = default_account_id
            .or(last_observed_account_id)
            .ok_or_else(|| "provider returned no usable account observations".to_string())?;
        provider.default_account_id = Some(observed_account_id.clone());
        if provider.selection == AccountSelection::Auto {
            provider.active_account_id = Some(observed_account_id);
        }
        let status = if report
            .source_outcomes
            .iter()
            .any(|outcome| outcome.status == SourceStatus::Unavailable)
        {
            OperationStatus::Partial
        } else {
            OperationStatus::Succeeded
        };
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)?;
        Ok((status, report.source_outcomes))
    }

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

    fn mark_source_outcomes(
        &self,
        provider_id: &str,
        outcomes: &[SourceOutcome],
    ) -> Result<(), String> {
        let mut provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned();
        let Some(mut provider) = provider.take() else {
            return Ok(());
        };
        mark_connections_unavailable(&mut provider, outcomes);
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)
    }

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
        let key = match key_store.read() {
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
                key_store.create().map_err(|error| {
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

fn installation_key_error(error: InstallationKeyError) -> String {
    match error {
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

fn provider_display_name(provider_id: &str) -> String {
    let mut characters = provider_id.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => "Provider".to_string(),
    }
}

fn log_operation_failure(provider_id: &str, operation_id: &str) {
    log::warn!(
        "provider account operation failed: provider={}, operation_id={}",
        provider_id,
        operation_id
    );
}

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
