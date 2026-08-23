use super::ProviderAccounts;
use super::model::{AccountId, ConnectionKind, DiscoveryReport};
use crate::plugin_engine::runtime::PluginOutput;

pub(crate) struct ActiveAccountProbe {
    provider_id: String,
    account_id: AccountId,
    identity_namespace: String,
    identity_fingerprint: String,
    connection_id: String,
    connection_key: String,
    connection_kind: ConnectionKind,
    credential_generation: String,
    started_at: time::OffsetDateTime,
    output: PluginOutput,
    claude_enrichment_lease: Option<super::claude_enrichment::ClaudeEnrichmentLease>,
}

pub(crate) trait ProviderAccountAdapter: Send + Sync {
    fn discover_default(&self) -> Result<DiscoveryReport, String>;

    fn credential_generation(&self, connection_key: &str) -> Result<String, String> {
        Ok(connection_key.to_string())
    }

    fn probe_connection(
        &self,
        _connection_key: &str,
        _credential_generation: &str,
    ) -> Result<PluginOutput, String> {
        Err("provider account probing is unsupported".to_string())
    }

    fn allows_scoped_credential_refresh(&self) -> bool {
        false
    }

    fn history_cookie(
        &self,
        _connection_key: &str,
        _credential_generation: &str,
    ) -> Result<crate::plugin_engine::account_runtime::HistoryCredential, String> {
        Err("provider account history is unsupported".to_string())
    }

    fn claude_oauth_identity(
        &self,
        _connection_key: &str,
        _credential_generation: &str,
        _cancellation: &crate::browser_sessions::CancellationToken,
    ) -> Result<crate::browser_sessions::VerifiedClaudeOAuthIdentity, String> {
        Err("Claude OAuth identity is unavailable".to_string())
    }

    fn output_metadata(&self) -> (String, String) {
        ("Cursor".to_string(), String::new())
    }
}

impl ProviderAccounts {
    pub(crate) fn prepare_active_probe(
        &self,
        provider_id: &str,
    ) -> Result<ActiveAccountProbe, String> {
        let started_at = time::OffsetDateTime::now_utc();
        let adapter = self
            .adapters
            .lock()
            .map_err(|_| "provider account adapters are unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| "Provider account refresh is unavailable.".to_string())?;
        let (account_id, identity_namespace, identity_fingerprint, connection) = {
            let providers = self
                .providers
                .lock()
                .map_err(|_| "provider account state is unavailable".to_string())?;
            let provider = providers
                .get(provider_id)
                .ok_or_else(|| "No account is available for this provider.".to_string())?;
            let account_id = provider
                .active_account_id
                .as_ref()
                .ok_or_else(|| "No active account is selected.".to_string())?;
            let account = provider
                .accounts
                .iter()
                .find(|account| &account.account_id == account_id)
                .ok_or_else(|| "The selected account is unavailable.".to_string())?;
            let connection = account
                .connections
                .iter()
                .filter(|connection| connection_can_probe(connection))
                .min_by_key(|connection| connection.kind)
                .ok_or_else(|| "The selected account has no available connection.".to_string())?;
            (
                account_id.clone(),
                account.identity_namespace.clone(),
                account.identity_fingerprint.clone(),
                connection.clone(),
            )
        };
        let (credential_generation, mut output) = if matches!(
            connection.kind,
            ConnectionKind::Chrome | ConnectionKind::Arc
        ) {
            self.probe_cursor_browser_connection(
                provider_id,
                &account_id,
                &connection,
                adapter.as_ref(),
            )?
        } else {
            let original_generation = adapter.credential_generation(&connection.connection_key)?;
            let output =
                adapter.probe_connection(&connection.connection_key, &original_generation)?;
            let generation = adapter.credential_generation(&connection.connection_key)?;
            if generation != original_generation && !adapter.allows_scoped_credential_refresh() {
                return Err("Account credentials changed during refresh. Try again.".to_string());
            }
            (generation, output)
        };

        if !matches!(
            connection.kind,
            ConnectionKind::Chrome | ConnectionKind::Arc
        ) && !self.local_connection_identity_is_current(
            provider_id,
            &identity_namespace,
            &identity_fingerprint,
            &connection.connection_key,
            connection.kind,
            adapter.as_ref(),
        )? {
            return Err("Account identity changed during refresh. Try again.".to_string());
        }

        let claude_enrichment_lease =
            if provider_id == "claude" && connection.kind == ConnectionKind::Cli {
                self.enrich_claude_team(
                    &account_id,
                    &connection.connection_id,
                    &connection.connection_key,
                    &credential_generation,
                    adapter.as_ref(),
                    &mut output,
                )
            } else {
                None
            };

        if !self.probe_binding_is_current(
            provider_id,
            &account_id,
            &identity_namespace,
            &identity_fingerprint,
            &connection.connection_id,
            &connection.connection_key,
        )? {
            return Err("Account selection changed during refresh. Try again.".to_string());
        }
        Ok(ActiveAccountProbe {
            provider_id: provider_id.to_string(),
            account_id,
            identity_namespace,
            identity_fingerprint,
            connection_id: connection.connection_id,
            connection_key: connection.connection_key,
            connection_kind: connection.kind,
            credential_generation,
            started_at,
            output,
            claude_enrichment_lease,
        })
    }

    #[cfg(test)]
    pub(crate) fn run_active_probe(&self, provider_id: &str) -> Result<PluginOutput, String> {
        self.prepare_active_probe(provider_id)
            .map(|probe| probe.output)
    }

    pub(crate) fn publish_active_probe(
        &self,
        probe: ActiveAccountProbe,
        publish: impl FnOnce(&PluginOutput, time::OffsetDateTime),
    ) -> Result<PluginOutput, String> {
        if probe.output.provider_id != probe.provider_id {
            return Err("Provider account probe returned the wrong provider.".to_string());
        }
        let adapter = self
            .adapters
            .lock()
            .map_err(|_| "provider account adapters are unavailable".to_string())?
            .get(&probe.provider_id)
            .cloned()
            .ok_or_else(|| "Provider account refresh is unavailable.".to_string())?;
        let generation_is_current = if matches!(
            probe.connection_kind,
            ConnectionKind::Chrome | ConnectionKind::Arc
        ) {
            self.current_browser_probe_generation(
                &probe.provider_id,
                &probe.account_id,
                &probe.connection_id,
                &probe.connection_key,
            )
            .as_deref()
                == Some(probe.credential_generation.as_str())
        } else {
            adapter
                .credential_generation(&probe.connection_key)?
                .as_str()
                == probe.credential_generation
        };
        if !generation_is_current {
            return Err("Account credentials changed during refresh. Try again.".to_string());
        }
        if !matches!(
            probe.connection_kind,
            ConnectionKind::Chrome | ConnectionKind::Arc
        ) && !self.local_connection_identity_is_current(
            &probe.provider_id,
            &probe.identity_namespace,
            &probe.identity_fingerprint,
            &probe.connection_key,
            probe.connection_kind,
            adapter.as_ref(),
        )? {
            return Err("Account identity changed during refresh. Try again.".to_string());
        }
        if probe
            .claude_enrichment_lease
            .as_ref()
            .is_some_and(|lease| !self.claude_enrichment_is_current(&probe.account_id, lease))
        {
            return Err(
                "Claude browser credentials changed during refresh. Try again.".to_string(),
            );
        }

        let providers = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?;
        if !binding_is_current(
            &providers,
            &probe.provider_id,
            &probe.account_id,
            &probe.identity_namespace,
            &probe.identity_fingerprint,
            &probe.connection_id,
            &probe.connection_key,
        ) {
            return Err("Account selection changed during refresh. Try again.".to_string());
        }
        let locked_provider = self
            .registry_store
            .as_ref()
            .map(|store| store.lock_provider(&probe.provider_id))
            .transpose()?;
        if locked_provider.as_ref().is_some_and(|locked| {
            !locked.provider().is_some_and(|provider| {
                persisted_binding_is_current(
                    provider,
                    &probe.account_id,
                    &probe.identity_namespace,
                    &probe.identity_fingerprint,
                    &probe.connection_id,
                    &probe.connection_key,
                )
            })
        }) {
            return Err("Account selection changed during refresh. Try again.".to_string());
        }

        if crate::plugin_engine::runtime::probe_error_message(&probe.output).is_none() {
            if let Some(store) = &self.snapshot_store {
                let started_at = format_timestamp(probe.started_at)?;
                let fetched_at = format_timestamp(time::OffsetDateTime::now_utc())?;
                if !store.save(
                    &probe.provider_id,
                    &probe.account_id,
                    &probe.output,
                    &started_at,
                    &fetched_at,
                )? {
                    return Err("A newer account snapshot is already available.".to_string());
                }
            }
        }
        publish(&probe.output, probe.started_at);
        drop(locked_provider);
        drop(providers);
        Ok(probe.output)
    }

    fn probe_binding_is_current(
        &self,
        provider_id: &str,
        account_id: &str,
        identity_namespace: &str,
        identity_fingerprint: &str,
        connection_id: &str,
        connection_key: &str,
    ) -> Result<bool, String> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?;
        Ok(binding_is_current(
            &providers,
            provider_id,
            account_id,
            identity_namespace,
            identity_fingerprint,
            connection_id,
            connection_key,
        ))
    }

    fn local_connection_identity_is_current(
        &self,
        provider_id: &str,
        identity_namespace: &str,
        identity_fingerprint: &str,
        connection_key: &str,
        connection_kind: ConnectionKind,
        adapter: &dyn ProviderAccountAdapter,
    ) -> Result<bool, String> {
        let report = adapter.discover_default()?;
        let installation_key = self.resolve_installation_key()?;
        Ok(report.observations.iter().any(|observation| {
            observation.connection_key == connection_key
                && observation.connection_kind == connection_kind
                && observation.identity_namespace == identity_namespace
                && super::identity::fingerprint(
                    &installation_key,
                    provider_id,
                    identity_namespace,
                    &observation.normalized_identity,
                ) == identity_fingerprint
        }))
    }
}

fn binding_is_current(
    providers: &std::collections::HashMap<String, super::state::ProviderState>,
    provider_id: &str,
    account_id: &str,
    identity_namespace: &str,
    identity_fingerprint: &str,
    connection_id: &str,
    connection_key: &str,
) -> bool {
    providers.get(provider_id).is_some_and(|provider| {
        provider.active_account_id.as_deref() == Some(account_id)
            && provider.accounts.iter().any(|account| {
                account.account_id == account_id
                    && account.identity_namespace == identity_namespace
                    && account.identity_fingerprint == identity_fingerprint
                    && account.connections.iter().any(|connection| {
                        connection.connection_id == connection_id
                            && connection.connection_key == connection_key
                            && connection.attached
                            && connection.available
                    })
            })
    })
}

fn persisted_binding_is_current(
    provider: &super::state::ProviderState,
    account_id: &str,
    identity_namespace: &str,
    identity_fingerprint: &str,
    connection_id: &str,
    connection_key: &str,
) -> bool {
    provider.active_account_id.as_deref() == Some(account_id)
        && provider.accounts.iter().any(|account| {
            account.account_id == account_id
                && account.identity_namespace == identity_namespace
                && account.identity_fingerprint == identity_fingerprint
                && account.connections.iter().any(|connection| {
                    connection.connection_id == connection_id
                        && connection.connection_key == connection_key
                        && connection.attached
                })
        })
}

fn connection_can_probe(connection: &super::state::ConnectionRecord) -> bool {
    connection.attached
        && (connection.available
            || matches!(
                connection.kind,
                ConnectionKind::Chrome | ConnectionKind::Arc
            ))
}

fn format_timestamp(value: time::OffsetDateTime) -> Result<String, String> {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| "provider account snapshot timestamp could not be formatted".to_string())
}

#[cfg(test)]
mod tests {
    use super::connection_can_probe;
    use crate::provider_accounts::ConnectionKind;
    use crate::provider_accounts::state::ConnectionRecord;

    fn connection(kind: ConnectionKind, attached: bool, available: bool) -> ConnectionRecord {
        ConnectionRecord {
            connection_id: "connection".to_string(),
            connection_key: "Profile 2".to_string(),
            kind,
            attached,
            attachment_revision: 0,
            available,
            session_ref: None,
        }
    }

    #[test]
    fn persisted_browser_binding_can_reacquire_only_until_it_is_detached() {
        assert!(connection_can_probe(&connection(
            ConnectionKind::Chrome,
            true,
            false,
        )));
        assert!(!connection_can_probe(&connection(
            ConnectionKind::Chrome,
            false,
            false,
        )));
        assert!(!connection_can_probe(&connection(
            ConnectionKind::Desktop,
            true,
            false,
        )));
    }
}
