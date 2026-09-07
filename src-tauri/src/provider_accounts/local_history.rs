use super::probe::{binding_is_current, persisted_binding_is_current};
use super::{ConnectionKind, ProviderAccounts};
use crate::plugin_engine::runtime::PluginOutput;

impl ProviderAccounts {
    pub(crate) fn run_local_history(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Result<PluginOutput, String> {
        if provider_id != "claude" {
            return Err("Local history is unavailable for this provider.".to_string());
        }
        let adapter = self
            .adapters
            .lock()
            .map_err(|_| "Provider account refresh is unavailable.".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| "Provider account refresh is unavailable.".to_string())?;
        let (namespace, fingerprint, connection) = {
            let providers = self
                .providers
                .lock()
                .map_err(|_| "Provider account state is unavailable.".to_string())?;
            let account = providers
                .get(provider_id)
                .filter(|provider| provider.active_account_id.as_deref() == Some(account_id))
                .and_then(|provider| {
                    provider
                        .accounts
                        .iter()
                        .find(|account| account.account_id == account_id)
                })
                .ok_or_else(|| {
                    "Account selection changed. Load local history again.".to_string()
                })?;
            let connection = account
                .connections
                .iter()
                .find(|connection| {
                    connection.kind == ConnectionKind::Cli
                        && connection.attached
                        && connection.available
                })
                .cloned()
                .ok_or_else(|| {
                    "Local history requires this account's CLI connection.".to_string()
                })?;
            (
                account.identity_namespace.clone(),
                account.identity_fingerprint.clone(),
                connection,
            )
        };

        let generation = adapter.credential_generation(&connection.connection_key)?;
        let output = adapter.probe_local_history(&connection.connection_key, &generation)?;
        if output.provider_id != provider_id {
            return Err("Local history returned the wrong provider.".to_string());
        }
        if adapter.credential_generation(&connection.connection_key)? != generation {
            return Err("Account credentials changed. Load local history again.".to_string());
        }
        if !self.local_connection_identity_is_current(
            provider_id,
            &namespace,
            &fingerprint,
            &connection.connection_key,
            connection.kind,
            adapter.as_ref(),
        )? {
            return Err("Account identity changed. Load local history again.".to_string());
        }

        // Use the same in-memory and persisted binding checks as quota publication, without
        // publishing a quota event or writing either the quota or account snapshot stores.
        let providers = self
            .providers
            .lock()
            .map_err(|_| "Provider account state is unavailable.".to_string())?;
        if !binding_is_current(
            &providers,
            provider_id,
            account_id,
            &namespace,
            &fingerprint,
            &connection.connection_id,
            &connection.connection_key,
        ) {
            return Err("Account selection changed. Load local history again.".to_string());
        }
        let locked_provider = self
            .registry_store
            .as_ref()
            .map(|store| store.lock_provider(provider_id))
            .transpose()?;
        if locked_provider.as_ref().is_some_and(|locked| {
            !locked.provider().is_some_and(|provider| {
                persisted_binding_is_current(
                    provider,
                    account_id,
                    &namespace,
                    &fingerprint,
                    &connection.connection_id,
                    &connection.connection_key,
                )
            })
        }) {
            return Err("Account selection changed. Load local history again.".to_string());
        }
        Ok(output)
    }
}
