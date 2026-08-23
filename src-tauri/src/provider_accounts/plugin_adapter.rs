use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, ProviderAccountAdapter, SourceOutcome,
    SourceStatus,
};
use crate::plugin_engine::account_runtime::{
    self, AccountDiscoveryIdentity, AccountDiscoveryResult,
};
use crate::plugin_engine::manifest::LoadedPlugin;
use std::path::PathBuf;
use std::sync::Arc;

use super::claude_profile::{
    CLAUDE_OAUTH_PROFILE_TIMEOUT, ClaudeOAuthProfileTransport, FixedClaudeOAuthProfileTransport,
};

pub(crate) struct QuickJsAccountAdapter {
    plugin: LoadedPlugin,
    app_data_dir: PathBuf,
    app_version: String,
    claude_profile_transport: Arc<dyn ClaudeOAuthProfileTransport>,
}

impl QuickJsAccountAdapter {
    pub(crate) fn new(plugin: LoadedPlugin, app_data_dir: PathBuf, app_version: String) -> Self {
        Self {
            plugin,
            app_data_dir,
            app_version,
            claude_profile_transport: Arc::new(FixedClaudeOAuthProfileTransport),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_claude_profile_transport(
        mut self,
        transport: Arc<dyn ClaudeOAuthProfileTransport>,
    ) -> Self {
        self.claude_profile_transport = transport;
        self
    }
}

impl ProviderAccountAdapter for QuickJsAccountAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        let result = account_runtime::discover_connections(
            &self.plugin,
            &self.app_data_dir,
            &self.app_version,
        )?;
        convert_discovery_with(result, |namespace, connection_key, connection_kind| {
            if namespace != "claude-oauth-profile-v1"
                || connection_key != "claude-oauth"
                || connection_kind != "cli"
            {
                return Err("Claude OAuth discovery returned an invalid connection".to_string());
            }
            let generation = self.credential_generation(connection_key)?;
            let identity = self.claude_oauth_identity(
                connection_key,
                &generation,
                &crate::browser_sessions::CancellationToken::new(),
            )?;
            Ok(identity.opaque_identity())
        })
    }

    fn credential_generation(&self, connection_key: &str) -> Result<String, String> {
        account_runtime::credential_generation(
            &self.plugin,
            &self.app_data_dir,
            &self.app_version,
            connection_key,
        )
    }

    fn probe_connection(
        &self,
        connection_key: &str,
        credential_generation: &str,
    ) -> Result<crate::plugin_engine::runtime::PluginOutput, String> {
        Ok(crate::plugin_engine::runtime::run_probe_for_connection(
            &self.plugin,
            &self.app_data_dir,
            &self.app_version,
            connection_key,
            credential_generation,
        ))
    }

    fn allows_scoped_credential_refresh(&self) -> bool {
        self.plugin.manifest.id == "cursor"
    }

    fn history_cookie(
        &self,
        connection_key: &str,
        credential_generation: &str,
    ) -> Result<crate::plugin_engine::account_runtime::HistoryCredential, String> {
        account_runtime::history_credential(
            &self.plugin,
            &self.app_data_dir,
            &self.app_version,
            connection_key,
            credential_generation,
        )
    }

    fn claude_oauth_identity(
        &self,
        connection_key: &str,
        credential_generation: &str,
        cancellation: &crate::browser_sessions::CancellationToken,
    ) -> Result<crate::browser_sessions::VerifiedClaudeOAuthIdentity, String> {
        if self.plugin.manifest.id != "claude" || connection_key != "claude-oauth" {
            return Err("Claude OAuth identity target is invalid".to_string());
        }
        if self.credential_generation(connection_key)? != credential_generation {
            return Err(
                "Claude OAuth credentials changed during identity verification".to_string(),
            );
        }
        let credential = account_runtime::claude_oauth_credential(
            &self.plugin,
            &self.app_data_dir,
            &self.app_version,
            connection_key,
            credential_generation,
        )?;
        let identity = self
            .claude_profile_transport
            .fetch_profile(
                credential.expose(),
                CLAUDE_OAUTH_PROFILE_TIMEOUT,
                cancellation,
            )
            .map_err(|_| "Claude OAuth identity verification failed".to_string())?;
        if self.credential_generation(connection_key)? != credential_generation {
            return Err(
                "Claude OAuth credentials changed during identity verification".to_string(),
            );
        }
        Ok(identity)
    }

    fn output_metadata(&self) -> (String, String) {
        (
            self.plugin.manifest.name.clone(),
            self.plugin.icon_data_url.clone(),
        )
    }
}

#[cfg(test)]
fn convert_discovery(result: AccountDiscoveryResult) -> Result<DiscoveryReport, String> {
    convert_discovery_with(result, |_, _, _| {
        Err("Claude OAuth identity is unavailable".to_string())
    })
}

fn convert_discovery_with(
    result: AccountDiscoveryResult,
    mut resolve_claude_identity: impl FnMut(&str, &str, &str) -> Result<String, String>,
) -> Result<DiscoveryReport, String> {
    let observations = result
        .observations
        .into_iter()
        .map(|claim| {
            let normalized_identity = match claim.identity {
                AccountDiscoveryIdentity::Normalized(identity) => identity,
                AccountDiscoveryIdentity::ClaudeOAuthProfile => resolve_claude_identity(
                    &claim.identity_namespace,
                    &claim.connection_key,
                    &claim.connection_kind,
                )?,
            };
            let connection_kind = match claim.connection_kind.as_str() {
                "desktop" => ConnectionKind::Desktop,
                "cli" => ConnectionKind::Cli,
                "chrome" => ConnectionKind::Chrome,
                "arc" => ConnectionKind::Arc,
                _ => return Err("plugin returned an unsupported connection kind".to_string()),
            };
            Ok(ObservedConnection {
                identity_namespace: claim.identity_namespace,
                normalized_identity,
                connection_key: claim.connection_key,
                connection_kind,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let source_outcomes = result
        .source_outcomes
        .into_iter()
        .map(|outcome| {
            let status = match outcome.status.as_str() {
                "available" => SourceStatus::Available,
                "absent" => SourceStatus::Absent,
                "unavailable" => SourceStatus::Unavailable,
                _ => return Err("plugin returned an unsupported source status".to_string()),
            };
            Ok(SourceOutcome::new(&outcome.source_key, status))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if result
        .default_connection_key
        .as_ref()
        .is_some_and(|default| {
            !observations
                .iter()
                .any(|observation| &observation.connection_key == default)
        })
    {
        return Err("plugin returned an unknown default connection".to_string());
    }
    Ok(DiscoveryReport {
        observations,
        source_outcomes,
        default_connection_key: result.default_connection_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::account_runtime::{AccountDiscoveryClaim, AccountSourceOutcome};

    #[test]
    fn converts_the_validated_plugin_contract_into_provider_accounts_types() {
        let report = convert_discovery(AccountDiscoveryResult {
            observations: vec![AccountDiscoveryClaim {
                identity_namespace: "cursor-sub-v1".to_string(),
                identity: AccountDiscoveryIdentity::Normalized("auth0|user".to_string()),
                connection_key: "cursor-desktop".to_string(),
                connection_kind: "desktop".to_string(),
            }],
            source_outcomes: vec![AccountSourceOutcome {
                source_key: "cursor-desktop".to_string(),
                status: "available".to_string(),
            }],
            default_connection_key: Some("cursor-desktop".to_string()),
        })
        .expect("contract converts");

        assert_eq!(report.observations.len(), 1);
        assert_eq!(
            report.observations[0].connection_kind,
            ConnectionKind::Desktop
        );
        assert_eq!(report.source_outcomes[0].status, SourceStatus::Available);
        assert_eq!(
            report.default_connection_key.as_deref(),
            Some("cursor-desktop")
        );
    }
}
