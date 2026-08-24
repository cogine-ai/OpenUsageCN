use super::ProviderAccounts;
use super::browser_cursor_probe::FixedBrowserCursorProbe;
use super::history_lease::browser_cookie_generation;
use super::probe::ProviderAccountAdapter;
use super::state::ConnectionRecord;
use crate::cursor_history::HistoryError;
use crate::plugin_engine::runtime::PluginOutput;

impl ProviderAccounts {
    pub(super) fn probe_cursor_browser_connection(
        &self,
        provider_id: &str,
        account_id: &str,
        connection: &ConnectionRecord,
        adapter: &dyn ProviderAccountAdapter,
    ) -> Result<(String, PluginOutput), String> {
        if provider_id != "cursor" {
            return Err("Browser quota refresh is unavailable for this provider.".to_string());
        }
        let (generation, _lease_cookie) = self
            .browser_history_credential(provider_id, account_id, connection)
            .map_err(browser_credential_error)?;
        let session_ref = self
            .providers
            .lock()
            .map_err(|_| "Provider account state is unavailable.".to_string())?
            .get(provider_id)
            .and_then(|provider| {
                provider
                    .accounts
                    .iter()
                    .find(|account| account.account_id == account_id)
            })
            .and_then(|account| {
                account
                    .connections
                    .iter()
                    .find(|current| current.connection_id == connection.connection_id)
            })
            .and_then(|current| current.session_ref.clone())
            .ok_or_else(|| "The selected Cursor browser session is unavailable.".to_string())?;
        let broker = self
            .browser_broker
            .lock()
            .map_err(|_| "Browser account access is unavailable.".to_string())?
            .clone()
            .ok_or_else(|| "Browser account access is unavailable.".to_string())?;
        let credential = broker
            .session_credential(&session_ref)
            .map_err(|_| "The selected Cursor browser session is unavailable.".to_string())?;
        if browser_cookie_generation(credential.cookie_header()) != generation {
            return Err("Account credentials changed during refresh. Try again.".to_string());
        }
        let (display_name, icon_url) = adapter.output_metadata();
        let correlation_id = uuid::Uuid::new_v4().to_string();
        let output = FixedBrowserCursorProbe::new()?.probe(
            credential.cookie_header(),
            credential.normalized_identity(),
            &display_name,
            &icon_url,
            &correlation_id,
        )?;
        if self
            .current_browser_probe_generation(
                provider_id,
                account_id,
                &connection.connection_id,
                &connection.connection_key,
            )
            .as_deref()
            != Some(generation.as_str())
        {
            return Err("Account credentials changed during refresh. Try again.".to_string());
        }
        Ok((generation, output))
    }

    pub(super) fn current_browser_probe_generation(
        &self,
        provider_id: &str,
        account_id: &str,
        connection_id: &str,
        connection_key: &str,
    ) -> Option<String> {
        let session_ref = self
            .providers
            .lock()
            .ok()?
            .get(provider_id)
            .and_then(|provider| {
                if provider.active_account_id.as_deref() != Some(account_id) {
                    return None;
                }
                provider
                    .accounts
                    .iter()
                    .find(|account| account.account_id == account_id)
                    .and_then(|account| {
                        account.connections.iter().find(|connection| {
                            connection.connection_id == connection_id
                                && connection.connection_key == connection_key
                                && connection.attached
                                && connection.available
                        })
                    })
                    .and_then(|connection| connection.session_ref.clone())
            })?;
        let broker = self.browser_broker.lock().ok()?.clone()?;
        let credential = broker.session_credential(&session_ref).ok()?;
        Some(browser_cookie_generation(credential.cookie_header()))
    }
}

fn browser_credential_error(error: HistoryError) -> String {
    match error {
        HistoryError::IdentityChanged => {
            "The selected Cursor browser profile is signed in to another account.".to_string()
        }
        HistoryError::AuthenticationUnavailable => {
            "The selected Cursor browser session is unavailable. Scan it again.".to_string()
        }
        _ => "The selected Cursor account changed during refresh. Try again.".to_string(),
    }
}
