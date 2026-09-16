use super::{ProviderAccounts, model::AccountSelection};

impl ProviderAccounts {
    pub(crate) fn removal_committed(&self, provider_id: &str, account_id: &str) -> bool {
        self.providers.lock().is_ok_and(|providers| {
            providers
                .get(provider_id)
                .is_some_and(|provider| provider.removed_account_ids.contains(account_id))
        })
    }

    pub(super) fn remove_account(&self, provider_id: &str, account_id: &str) -> Result<(), String> {
        // Keep the runtime lock until caches are cleared. Probe/history commits take this
        // same lock and also validate the persisted binding, including across processes.
        let mut providers = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?;
        let mut provider = providers
            .get(provider_id)
            .cloned()
            .ok_or("provider has no accounts")?;
        let removed = provider
            .accounts
            .iter()
            .find(|account| account.account_id == account_id)
            .cloned();
        if let Some(account) = &removed {
            let revision = provider
                .identity_revisions
                .entry(account.identity_fingerprint.clone())
                .or_default();
            if *revision % 2 == 0 {
                *revision = revision
                    .checked_add(1)
                    .ok_or("identity revision is exhausted")?;
            }
            provider.removed_account_ids.insert(account_id.to_string());
            provider
                .accounts
                .retain(|account| account.account_id != account_id);
            if provider.default_account_id.as_deref() == Some(account_id) {
                provider.default_account_id = None;
            }
            if provider.active_account_id.as_deref() == Some(account_id) {
                provider.selection = AccountSelection::Auto;
                provider.active_account_id = None;
                provider.selection_revision = provider
                    .selection_revision
                    .checked_add(1)
                    .ok_or("selection revision is exhausted")?;
            }
            let persisted = self.persist_provider(provider_id, &provider)?;
            providers.insert(provider_id.to_string(), persisted);
            if let Some(broker) = self
                .browser_broker
                .lock()
                .map_err(|_| "browser session broker is unavailable")?
                .as_ref()
            {
                for connection in &account.connections {
                    if let Some(session) = &connection.session_ref {
                        broker.release_session(session);
                    }
                }
            }
        } else if !provider.removed_account_ids.contains(account_id) {
            return Err("account was not found".to_string());
        }
        // A failed cleanup is reported and can be retried using the removed ID.
        if let Some(store) = &self.snapshot_store {
            store.clear(provider_id, account_id)?;
        }
        if let Some(store) = &self.history_store {
            store
                .clear(provider_id, account_id)
                .map_err(|error| format!("account usage cache could not be cleared: {error:?}"))?;
        }
        self.enrichment_warnings
            .lock()
            .map_err(|_| "account warnings are unavailable")?
            .remove(&(provider_id.to_string(), account_id.to_string()));
        Ok(())
    }
}
