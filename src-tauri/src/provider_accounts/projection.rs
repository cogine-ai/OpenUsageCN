use super::ProviderAccounts;
use crate::plugin_engine::runtime::PluginOutput;

#[derive(Clone)]
pub(crate) struct ActiveAccountProjection {
    pub(crate) output: PluginOutput,
    pub(crate) started_at: time::OffsetDateTime,
}

pub(crate) enum ActiveProjectionError {
    AccountsUnavailable(String),
    SelectedSnapshotInvalid(String),
}

impl ActiveProjectionError {
    pub(crate) fn clear_existing_projection(&self) -> bool {
        matches!(self, Self::SelectedSnapshotInvalid(_))
    }
}

impl std::fmt::Display for ActiveProjectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccountsUnavailable(message) | Self::SelectedSnapshotInvalid(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl ProviderAccounts {
    pub(crate) fn active_projection(
        &self,
        provider_id: &str,
    ) -> Result<Option<ActiveAccountProjection>, ActiveProjectionError> {
        if self.registry_store.is_none() && self.snapshot_store.is_none() {
            if let Some(warning) = self.current_persistence_warning() {
                return Err(ActiveProjectionError::AccountsUnavailable(format!(
                    "{} Correlation ID: {}",
                    warning.message, warning.correlation_id
                )));
            }
        }
        let account_id = {
            let providers = self.providers.lock().map_err(|_| {
                ActiveProjectionError::AccountsUnavailable(
                    "provider account state is unavailable".to_string(),
                )
            })?;
            let Some(provider) = providers.get(provider_id) else {
                return Ok(None);
            };
            let Some(account_id) = provider.active_account_id.as_ref() else {
                return Ok(None);
            };
            let account_is_attached = provider.accounts.iter().any(|account| {
                &account.account_id == account_id
                    && account
                        .connections
                        .iter()
                        .any(|connection| connection.attached)
            });
            if !account_is_attached {
                return Ok(None);
            }
            account_id.clone()
        };
        let Some(snapshot_store) = &self.snapshot_store else {
            return Ok(None);
        };
        let Some(snapshot) = snapshot_store
            .load(provider_id, &account_id)
            .map_err(ActiveProjectionError::SelectedSnapshotInvalid)?
        else {
            return Ok(None);
        };
        let started_at = time::OffsetDateTime::parse(
            snapshot.started_at.trim(),
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| {
            ActiveProjectionError::SelectedSnapshotInvalid(
                "provider account snapshot timestamp is invalid".to_string(),
            )
        })?;
        let icon_url = self
            .adapters
            .lock()
            .map_err(|_| {
                ActiveProjectionError::SelectedSnapshotInvalid(
                    "provider account adapters are unavailable".to_string(),
                )
            })?
            .get(provider_id)
            .map(|adapter| adapter.output_metadata().1)
            .unwrap_or_default();
        Ok(Some(ActiveAccountProjection {
            output: PluginOutput {
                provider_id: provider_id.to_string(),
                display_name: snapshot.display_name,
                plan: snapshot.plan,
                lines: snapshot.lines,
                icon_url,
            },
            started_at,
        }))
    }
}
