use super::ProviderAccounts;
use super::identity;
use super::model::{
    AccountSelection, ConnectionKind, OperationStatus, SourceOutcome, SourceStatus,
};
use super::state::{AccountRecord, ConnectionRecord};
use crate::browser_sessions::{Browser, BrowserSessionBroker, CookieProvider};
use std::sync::Arc;

const CURSOR_IDENTITY_NAMESPACE: &str = "cursor-sub-v1";

struct ClaimedBrowserSession {
    broker: Arc<BrowserSessionBroker>,
    session_ref: String,
    retained: bool,
}

impl ClaimedBrowserSession {
    fn new(broker: Arc<BrowserSessionBroker>, session_ref: String) -> Self {
        Self {
            broker,
            session_ref,
            retained: false,
        }
    }

    fn retain(&mut self) {
        self.retained = true;
    }
}

impl Drop for ClaimedBrowserSession {
    fn drop(&mut self) {
        if !self.retained {
            self.broker.release_session(&self.session_ref);
        }
    }
}

impl ProviderAccounts {
    pub(super) fn attach_browser_candidate(
        &self,
        provider_id: &str,
        candidate_id: &str,
    ) -> Result<(OperationStatus, Vec<SourceOutcome>), String> {
        match provider_id {
            "cursor" => self.attach_cursor_browser_candidate(candidate_id),
            "claude" => self.attach_claude_browser_candidate(candidate_id),
            _ => Err("browser account attachment is unsupported for this provider".to_string()),
        }
    }

    fn attach_cursor_browser_candidate(
        &self,
        candidate_id: &str,
    ) -> Result<(OperationStatus, Vec<SourceOutcome>), String> {
        let provider_id = "cursor";
        let broker = self
            .browser_broker
            .lock()
            .map_err(|_| "browser account access is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "browser account access is unavailable".to_string())?;
        let claim = broker
            .claim_candidate(candidate_id)
            .map_err(|_| "browser account candidate is unavailable".to_string())?;
        if claim.provider() != CookieProvider::Cursor {
            return Err("browser account candidate belongs to another provider".to_string());
        }
        let kind = match claim.browser() {
            Browser::Chrome => ConnectionKind::Chrome,
            Browser::Arc => ConnectionKind::Arc,
        };
        let profile_key = claim.profile_key().to_string();
        let session_ref = claim.session_ref().to_string();
        let mut claimed_session =
            ClaimedBrowserSession::new(Arc::clone(&broker), session_ref.clone());
        let installation_key = self.resolve_installation_key()?;
        let fingerprint = identity::fingerprint(
            &installation_key,
            provider_id,
            CURSOR_IDENTITY_NAMESPACE,
            claim.normalized_identity(),
        );

        let mut provider = self
            .providers
            .lock()
            .map_err(|_| "provider account state is unavailable".to_string())?
            .get(provider_id)
            .cloned()
            .unwrap_or_default();
        let mut replaced_sessions = Vec::new();
        for account in &mut provider.accounts {
            for connection in &mut account.connections {
                if connection.kind == kind && connection.connection_key == profile_key {
                    connection.available = false;
                    if connection.attached {
                        connection.attached = false;
                        connection.attachment_revision = connection
                            .attachment_revision
                            .checked_add(1)
                            .ok_or_else(|| {
                                "browser connection attachment revision is exhausted".to_string()
                            })?;
                    }
                    if let Some(session_ref) = connection.session_ref.take() {
                        replaced_sessions.push(session_ref);
                    }
                }
            }
        }
        let existing_index = provider
            .accounts
            .iter()
            .position(|account| account.identity_fingerprint == fingerprint);
        let is_new_account = existing_index.is_none();
        let account_index = existing_index.unwrap_or_else(|| {
            let account_number = provider.accounts.len() + 1;
            provider.accounts.push(AccountRecord {
                account_id: uuid::Uuid::new_v4().to_string(),
                label: format!("Account {account_number}"),
                label_revision: 0,
                identity_namespace: CURSOR_IDENTITY_NAMESPACE.to_string(),
                identity_fingerprint: fingerprint,
                connections: Vec::new(),
            });
            provider.accounts.len() - 1
        });
        let account_id = {
            let account = &mut provider.accounts[account_index];
            if let Some(connection) = account.connections.iter_mut().find(|connection| {
                connection.kind == kind && connection.connection_key == profile_key
            }) {
                connection.available = true;
                connection.attached = true;
                connection.attachment_revision = connection
                    .attachment_revision
                    .checked_add(1)
                    .ok_or_else(|| {
                        "browser connection attachment revision is exhausted".to_string()
                    })?;
                connection.session_ref = Some(session_ref);
            } else {
                account.connections.push(ConnectionRecord {
                    connection_id: uuid::Uuid::new_v4().to_string(),
                    connection_key: profile_key.clone(),
                    kind,
                    attached: true,
                    attachment_revision: 1,
                    available: true,
                    session_ref: Some(session_ref),
                });
            }
            account.account_id.clone()
        };
        if is_new_account {
            provider.selection_revision = provider
                .selection_revision
                .checked_add(1)
                .ok_or_else(|| "account selection revision is exhausted".to_string())?;
            provider.selection = AccountSelection::Pinned(account_id.clone());
            provider.active_account_id = Some(account_id);
        }
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)?;
        for session_ref in replaced_sessions {
            broker.release_session(&session_ref);
        }
        claimed_session.retain();
        Ok((
            OperationStatus::Succeeded,
            vec![SourceOutcome::new(&profile_key, SourceStatus::Available)],
        ))
    }

    fn attach_claude_browser_candidate(
        &self,
        candidate_id: &str,
    ) -> Result<(OperationStatus, Vec<SourceOutcome>), String> {
        const NAMESPACE: &str = "claude-oauth-profile-v1";
        let broker = self
            .browser_broker
            .lock()
            .map_err(|_| "Claude browser access is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Claude browser access is unavailable".to_string())?;
        let claim = broker
            .claim_candidate(candidate_id)
            .map_err(|_| "Claude browser candidate is unavailable".to_string())?;
        let session_ref = claim.session_ref().to_string();
        let result = (|| {
            if claim.provider() != CookieProvider::Claude {
                return Err("Claude browser candidate belongs to another provider".to_string());
            }
            let kind = match claim.browser() {
                Browser::Chrome => ConnectionKind::Chrome,
                Browser::Arc => ConnectionKind::Arc,
            };
            let profile_key = claim.profile_key().to_string();
            let installation_key = self.resolve_installation_key()?;
            let fingerprint = identity::fingerprint(
                &installation_key,
                "claude",
                NAMESPACE,
                claim.normalized_identity(),
            );
            let mut provider = self
                .providers
                .lock()
                .map_err(|_| "Claude account state is unavailable".to_string())?
                .get("claude")
                .cloned()
                .ok_or_else(|| "No Claude OAuth account is available".to_string())?;
            let account_id = provider
                .active_account_id
                .clone()
                .ok_or_else(|| "No active Claude OAuth account is selected".to_string())?;
            let account_index = provider
                .accounts
                .iter()
                .position(|account| {
                    account.account_id == account_id
                        && account.identity_namespace == NAMESPACE
                        && account.identity_fingerprint == fingerprint
                        && account.connections.iter().any(|connection| {
                            connection.kind == ConnectionKind::Cli
                                && connection.connection_key == "claude-oauth"
                                && connection.attached
                                && connection.available
                        })
                })
                .ok_or_else(|| {
                    "Claude browser identity does not match the selected OAuth account".to_string()
                })?;
            let mut replaced_sessions = Vec::new();
            for account in &mut provider.accounts {
                for connection in &mut account.connections {
                    if connection.kind == kind && connection.connection_key == profile_key {
                        connection.available = false;
                        if connection.attached {
                            connection.attached = false;
                            connection.attachment_revision = connection
                                .attachment_revision
                                .checked_add(1)
                                .ok_or_else(|| {
                                    "browser connection attachment revision is exhausted"
                                        .to_string()
                                })?;
                        }
                        if let Some(replaced) = connection.session_ref.take() {
                            replaced_sessions.push(replaced);
                        }
                    }
                }
            }
            let account = &mut provider.accounts[account_index];
            if let Some(connection) = account.connections.iter_mut().find(|connection| {
                connection.kind == kind && connection.connection_key == profile_key
            }) {
                connection.available = true;
                connection.attached = true;
                connection.attachment_revision = connection
                    .attachment_revision
                    .checked_add(1)
                    .ok_or_else(|| {
                        "browser connection attachment revision is exhausted".to_string()
                    })?;
                connection.session_ref = Some(session_ref.clone());
            } else {
                account.connections.push(ConnectionRecord {
                    connection_id: uuid::Uuid::new_v4().to_string(),
                    connection_key: profile_key.clone(),
                    kind,
                    attached: true,
                    attachment_revision: 1,
                    available: true,
                    session_ref: Some(session_ref.clone()),
                });
            }
            let persisted = self.persist_provider("claude", &provider)?;
            self.replace_provider_state("claude", persisted)?;
            for replaced in replaced_sessions {
                broker.release_session(&replaced);
            }
            Ok((
                OperationStatus::Succeeded,
                vec![SourceOutcome::new(&profile_key, SourceStatus::Available)],
            ))
        })();
        if result.is_err() {
            broker.release_session(&session_ref);
        }
        result
    }

    pub(super) fn detach_browser_connection(
        &self,
        provider_id: &str,
        account_id: &str,
        connection_id: &str,
    ) -> Result<(), String> {
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
        let connection = account
            .connections
            .iter_mut()
            .find(|connection| connection.connection_id == connection_id)
            .ok_or_else(|| format!("connection '{connection_id}' was not found"))?;
        if !matches!(
            connection.kind,
            ConnectionKind::Chrome | ConnectionKind::Arc
        ) {
            return Err("only browser connections can be detached".to_string());
        }
        connection.available = false;
        connection.attached = false;
        connection.attachment_revision = connection
            .attachment_revision
            .checked_add(1)
            .ok_or_else(|| "browser connection attachment revision is exhausted".to_string())?;
        let released_session = connection.session_ref.take();
        let persisted = self.persist_provider(provider_id, &provider)?;
        self.replace_provider_state(provider_id, persisted)?;
        if let (Some(broker), Some(session_ref)) = (
            self.browser_broker
                .lock()
                .map_err(|_| "browser account access is unavailable".to_string())?
                .clone(),
            released_session,
        ) {
            broker.release_session(&session_ref);
        }
        Ok(())
    }
}
