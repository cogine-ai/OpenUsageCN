use super::ProviderAccounts;
use super::identity;
use super::model::{
    AccountSelection, ConnectionKind, DiscoveryReport, OperationStatus, SourceOutcome, SourceStatus,
};
use super::state::{AccountRecord, ConnectionRecord, ProviderState, mark_connections_unavailable};

const CURSOR_DESKTOP: &str = "cursor-desktop";
const CURSOR_CLI: &str = "cursor-cli";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LocalRefresh {
    Active,
    Reconnect,
    FollowDefault,
    CursorDesktop,
}

impl ProviderAccounts {
    /// Reconciles local identities, honoring prior removals unless explicit reconnection was requested.
    pub(super) fn refresh_local(
        &self,
        provider_id: &str,
        request: LocalRefresh,
    ) -> Result<(OperationStatus, Vec<SourceOutcome>), String> {
        let use_saved_cursor_connections =
            provider_id == "cursor" && request == LocalRefresh::Active;
        if use_saved_cursor_connections && self.cursor_has_browser_only_selection()? {
            return Ok((OperationStatus::Succeeded, Vec::new()));
        }

        let adapter = self
            .adapters
            .lock()
            .map_err(|_| "provider account adapters are unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .ok_or_else(|| format!("provider '{provider_id}' does not support accounts"))?;
        let mut report = match adapter.discover_default() {
            Ok(report) => report,
            Err(error)
                if request == LocalRefresh::FollowDefault
                    || (use_saved_cursor_connections && self.active_cursor_has_browser()?) =>
            {
                log::warn!(
                    "Cursor local account discovery failed: {}",
                    crate::plugin_engine::host_api::redact_log_message(&error)
                );
                DiscoveryReport {
                    observations: Vec::new(),
                    source_outcomes: vec![
                        SourceOutcome::new(CURSOR_DESKTOP, SourceStatus::Unavailable),
                        SourceOutcome::new(CURSOR_CLI, SourceStatus::Unavailable),
                    ],
                    default_connection_key: None,
                }
            }
            Err(error) => return Err(error),
        };
        if request == LocalRefresh::CursorDesktop {
            report.observations.retain(|observation| {
                observation.connection_kind == ConnectionKind::Desktop
                    && observation.connection_key == CURSOR_DESKTOP
            });
            report
                .source_outcomes
                .retain(|outcome| outcome.source_key == CURSOR_DESKTOP);
            report.default_connection_key = Some(CURSOR_DESKTOP.into());
        }
        if report.observations.is_empty() {
            let followed_saved = self.record_empty_discovery(
                provider_id,
                &report.source_outcomes,
                request == LocalRefresh::FollowDefault,
            )?;
            let status = if followed_saved
                || (use_saved_cursor_connections && self.active_cursor_has_browser()?)
            {
                OperationStatus::Partial
            } else {
                OperationStatus::Failed
            };
            return Ok((status, report.source_outcomes));
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
        let preserve_browser = use_saved_cursor_connections
            && active_account(&provider).is_some_and(|account| {
                has_browser(account)
                    && account.connections.iter().any(|connection| {
                        connection.attached
                            && report.source_outcomes.iter().any(|outcome| {
                                outcome.source_key == connection.connection_key
                                    && outcome.status == SourceStatus::Unavailable
                            })
                    })
            });
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
            if provider
                .identity_revisions
                .get(&fingerprint)
                .is_some_and(|revision| revision % 2 == 1)
            {
                if !matches!(
                    request,
                    LocalRefresh::Reconnect | LocalRefresh::CursorDesktop
                ) {
                    continue;
                }
                let revision = provider.identity_revisions.get_mut(&fingerprint).unwrap();
                *revision = revision
                    .checked_add(1)
                    .ok_or("identity revision is exhausted")?;
            }
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
        let observed_account_id = default_account_id.or(last_observed_account_id);
        let followed_saved =
            request == LocalRefresh::FollowDefault && observed_account_id.is_none();
        match request {
            LocalRefresh::CursorDesktop => {
                let Some(account_id) = observed_account_id else {
                    return Ok((OperationStatus::Failed, report.source_outcomes));
                };
                provider.selection_revision = provider
                    .selection_revision
                    .checked_add(1)
                    .ok_or("account selection revision is exhausted")?;
                provider.selection = AccountSelection::Pinned(account_id.clone());
                provider.active_account_id = Some(account_id);
            }
            LocalRefresh::FollowDefault => {
                if observed_account_id.is_some() {
                    provider.default_account_id = observed_account_id;
                }
                if !follow_saved_default(&mut provider)? {
                    return Ok((OperationStatus::Failed, report.source_outcomes));
                }
            }
            LocalRefresh::Active | LocalRefresh::Reconnect => {
                provider.default_account_id = observed_account_id.clone();
                if provider.selection == AccountSelection::Auto && !preserve_browser {
                    provider.active_account_id = observed_account_id;
                }
            }
        }
        let status = if followed_saved
            || report
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

    fn active_cursor_has_browser(&self) -> Result<bool, String> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable")?;
        Ok(providers
            .get("cursor")
            .and_then(active_account)
            .is_some_and(has_browser))
    }

    fn cursor_has_browser_only_selection(&self) -> Result<bool, String> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable")?;
        Ok(providers
            .get("cursor")
            .filter(|provider| matches!(provider.selection, AccountSelection::Pinned(_)))
            .and_then(active_account)
            .is_some_and(|account| {
                has_browser(account)
                    && !account.connections.iter().any(|connection| {
                        connection.attached
                            && matches!(
                                connection.kind,
                                ConnectionKind::Desktop | ConnectionKind::Cli
                            )
                    })
            }))
    }

    /// Saves source availability and any explicit choice to follow a saved default together.
    fn record_empty_discovery(
        &self,
        provider_id: &str,
        outcomes: &[SourceOutcome],
        follow_default: bool,
    ) -> Result<bool, String> {
        let provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned();
        let Some(mut provider) = provider else {
            return Ok(false);
        };
        mark_connections_unavailable(&mut provider, outcomes);
        let followed_saved = follow_default && follow_saved_default(&mut provider)?;
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)?;
        Ok(followed_saved)
    }
}

/// Restores automatic selection when the default account is still in the registry.
fn follow_saved_default(provider: &mut ProviderState) -> Result<bool, String> {
    let Some(account_id) = provider.default_account_id.as_ref().filter(|id| {
        provider
            .accounts
            .iter()
            .any(|account| &account.account_id == *id)
    }) else {
        return Ok(false);
    };
    provider.selection_revision = provider
        .selection_revision
        .checked_add(1)
        .ok_or("account selection revision is exhausted")?;
    provider.selection = AccountSelection::Auto;
    provider.active_account_id = Some(account_id.clone());
    Ok(true)
}

fn active_account(provider: &ProviderState) -> Option<&AccountRecord> {
    let account_id = provider.active_account_id.as_ref()?;
    provider
        .accounts
        .iter()
        .find(|account| &account.account_id == account_id)
}

fn has_browser(account: &AccountRecord) -> bool {
    account.connections.iter().any(|connection| {
        connection.attached
            && matches!(
                connection.kind,
                ConnectionKind::Chrome | ConnectionKind::Arc
            )
    })
}
