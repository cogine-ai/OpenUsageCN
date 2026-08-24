use super::ProviderAccounts;
use super::identity;
use super::model::ConnectionKind;
use crate::browser_sessions::{Browser, CancellationToken, ClaudeProfileDiscovery};

const CLAUDE_IDENTITY_NAMESPACE: &str = "claude-oauth-profile-v1";
const CLAUDE_OAUTH_CONNECTION_KEY: &str = "claude-oauth";

impl ProviderAccounts {
    pub(crate) fn discover_claude_browser_profile(
        &self,
        browser: Browser,
        profile_key: &str,
        cancellation: &CancellationToken,
    ) -> Result<ClaudeProfileDiscovery, String> {
        if cancellation.is_cancelled() {
            return Err("Claude browser discovery was cancelled".to_string());
        }
        let adapter = self
            .adapters
            .lock()
            .map_err(|_| "Claude account access is unavailable".to_string())?
            .get("claude")
            .cloned()
            .ok_or_else(|| "Claude account access is unavailable".to_string())?;
        let binding = self.active_claude_oauth_binding()?;
        let generation = adapter.credential_generation(&binding.connection_key)?;
        let oauth_identity =
            adapter.claude_oauth_identity(&binding.connection_key, &generation, cancellation)?;
        let installation_key = self.resolve_installation_key()?;
        let fingerprint = identity::fingerprint(
            &installation_key,
            "claude",
            CLAUDE_IDENTITY_NAMESPACE,
            &oauth_identity.opaque_identity(),
        );
        if fingerprint != binding.identity_fingerprint
            || !self.claude_oauth_binding_is_current(&binding)?
        {
            return Err("The selected Claude account changed during discovery".to_string());
        }
        let broker = self
            .browser_broker
            .lock()
            .map_err(|_| "Claude browser access is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Claude browser access is unavailable".to_string())?;
        let discovery =
            broker.discover_claude_specific(browser, profile_key, &oauth_identity, cancellation);
        if adapter.credential_generation(&binding.connection_key)? != generation
            || !self.claude_oauth_binding_is_current(&binding)?
        {
            return Err("The selected Claude account changed during discovery".to_string());
        }
        Ok(discovery)
    }

    fn active_claude_oauth_binding(&self) -> Result<ClaudeOAuthBinding, String> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| "Claude account state is unavailable".to_string())?;
        let provider = providers
            .get("claude")
            .ok_or_else(|| "No Claude OAuth account is available".to_string())?;
        let account_id = provider
            .active_account_id
            .as_ref()
            .ok_or_else(|| "No active Claude OAuth account is selected".to_string())?;
        let account = provider
            .accounts
            .iter()
            .find(|account| &account.account_id == account_id)
            .ok_or_else(|| "The selected Claude OAuth account is unavailable".to_string())?;
        if account.identity_namespace != CLAUDE_IDENTITY_NAMESPACE {
            return Err("The selected Claude account has no verified OAuth identity".to_string());
        }
        let connection = account
            .connections
            .iter()
            .find(|connection| {
                connection.kind == ConnectionKind::Cli
                    && connection.connection_key == CLAUDE_OAUTH_CONNECTION_KEY
                    && connection.attached
                    && connection.available
            })
            .ok_or_else(|| "The selected Claude OAuth connection is unavailable".to_string())?;
        Ok(ClaudeOAuthBinding {
            account_id: account.account_id.clone(),
            identity_fingerprint: account.identity_fingerprint.clone(),
            connection_id: connection.connection_id.clone(),
            connection_key: connection.connection_key.clone(),
        })
    }

    fn claude_oauth_binding_is_current(
        &self,
        binding: &ClaudeOAuthBinding,
    ) -> Result<bool, String> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| "Claude account state is unavailable".to_string())?;
        Ok(providers.get("claude").is_some_and(|provider| {
            provider.active_account_id.as_deref() == Some(binding.account_id.as_str())
                && provider.accounts.iter().any(|account| {
                    account.account_id == binding.account_id
                        && account.identity_namespace == CLAUDE_IDENTITY_NAMESPACE
                        && account.identity_fingerprint == binding.identity_fingerprint
                        && account.connections.iter().any(|connection| {
                            connection.connection_id == binding.connection_id
                                && connection.connection_key == binding.connection_key
                                && connection.kind == ConnectionKind::Cli
                                && connection.attached
                                && connection.available
                        })
                })
        }))
    }
}

struct ClaudeOAuthBinding {
    account_id: String,
    identity_fingerprint: String,
    connection_id: String,
    connection_key: String,
}
