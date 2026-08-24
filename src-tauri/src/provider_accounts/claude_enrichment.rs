use super::model::ProviderEnrichmentWarning;
use super::probe::ProviderAccountAdapter;
use super::state::ConnectionRecord;
use super::{ConnectionKind, ProviderAccounts};
use crate::browser_sessions::{
    Browser, BrowserSessionBroker, CancellationToken, ClaudeTeamEnrichment, ClaudeTeamWarningCode,
    CookieProvider, VerifiedClaudeOAuthIdentity,
};
use crate::plugin_engine::runtime::PluginOutput;
use std::sync::Arc;

pub(super) struct ClaudeEnrichmentLease {
    connection_id: String,
    connection_key: String,
    session_ref: String,
    credential_generation: u64,
}

#[derive(Default)]
pub(super) struct ClaudeEnrichmentResult {
    pub(super) lease: Option<ClaudeEnrichmentLease>,
    pub(super) warning: Option<ProviderEnrichmentWarning>,
}

struct ClaudeBrowserBinding {
    account_id: String,
    connection_id: String,
    connection_key: String,
    browser: Browser,
    session_ref: Option<String>,
}

impl ProviderAccounts {
    pub(super) fn enrich_claude_team(
        &self,
        account_id: &str,
        oauth_connection_id: &str,
        oauth_connection_key: &str,
        oauth_generation: &str,
        adapter: &dyn ProviderAccountAdapter,
        output: &mut PluginOutput,
    ) -> ClaudeEnrichmentResult {
        if output.provider_id != "claude"
            || output.plan.as_deref() != Some("Team")
            || crate::plugin_engine::runtime::probe_error_message(output).is_some()
        {
            return ClaudeEnrichmentResult::default();
        }
        let cancellation = CancellationToken::new();
        let oauth_identity = match adapter.claude_oauth_identity(
            oauth_connection_key,
            oauth_generation,
            &cancellation,
        ) {
            Ok(identity) => identity,
            Err(_) => {
                return enrichment_warning("oauthIdentityUnavailable");
            }
        };
        if adapter
            .credential_generation(oauth_connection_key)
            .ok()
            .as_deref()
            != Some(oauth_generation)
        {
            return enrichment_warning("oauthCredentialsChanged");
        }
        let binding = match self.claude_browser_binding(
            account_id,
            oauth_connection_id,
            oauth_connection_key,
        ) {
            Some(binding) => binding,
            None => return enrichment_warning("browserProfileUnavailable"),
        };
        let broker = match self
            .browser_broker
            .lock()
            .ok()
            .and_then(|broker| broker.clone())
        {
            Some(broker) => broker,
            None => {
                return enrichment_warning("browserBrokerUnavailable");
            }
        };

        let result = self.refresh_or_reacquire_claude_enrichment(
            &binding,
            oauth_connection_id,
            oauth_connection_key,
            oauth_generation,
            adapter,
            &oauth_identity,
            &broker,
            &cancellation,
        );
        let Some((enrichment, session_ref, generation)) = result else {
            return enrichment_warning("providerUnavailable");
        };
        if !enrichment.exact {
            return enrichment_warning(
                enrichment
                    .warning
                    .map(warning_code)
                    .unwrap_or("providerUnavailable"),
            );
        }
        output.plan = Some(enrichment.plan.label().to_string());
        ClaudeEnrichmentResult {
            lease: Some(ClaudeEnrichmentLease {
                connection_id: binding.connection_id,
                connection_key: binding.connection_key,
                session_ref,
                credential_generation: generation,
            }),
            warning: None,
        }
    }

    pub(super) fn commit_claude_enrichment_warning(
        &self,
        account_id: &str,
        warning: Option<ProviderEnrichmentWarning>,
    ) {
        let key = ("claude".to_string(), account_id.to_string());
        let mut warnings = match self.enrichment_warnings.lock() {
            Ok(warnings) => warnings,
            Err(_) => {
                log::error!("Claude Team verification status is unavailable");
                return;
            }
        };
        match warning {
            Some(warning) => {
                if warnings
                    .get(&key)
                    .is_some_and(|current| current.code == warning.code)
                {
                    return;
                }
                log::warn!(
                    "Claude Team enrichment unavailable: code={}, correlation_id={}",
                    warning.code,
                    warning.correlation_id
                );
                warnings.insert(key, warning);
            }
            None => {
                warnings.remove(&key);
            }
        }
    }

    pub(super) fn claude_enrichment_is_current(
        &self,
        account_id: &str,
        lease: &ClaudeEnrichmentLease,
    ) -> bool {
        let session_is_bound = self.providers.lock().ok().is_some_and(|providers| {
            providers.get("claude").is_some_and(|provider| {
                provider.active_account_id.as_deref() == Some(account_id)
                    && provider.accounts.iter().any(|account| {
                        account.account_id == account_id
                            && account.connections.iter().any(|connection| {
                                connection.connection_id == lease.connection_id
                                    && connection.connection_key == lease.connection_key
                                    && connection.attached
                                    && connection.available
                                    && connection.session_ref.as_deref()
                                        == Some(lease.session_ref.as_str())
                            })
                    })
            })
        });
        if !session_is_bound {
            return false;
        }
        self.browser_broker
            .lock()
            .ok()
            .and_then(|broker| broker.clone())
            .and_then(|broker| broker.session_credential(&lease.session_ref).ok())
            .is_some_and(|credential| credential.generation() == lease.credential_generation)
    }

    #[allow(clippy::too_many_arguments)]
    fn refresh_or_reacquire_claude_enrichment(
        &self,
        binding: &ClaudeBrowserBinding,
        oauth_connection_id: &str,
        oauth_connection_key: &str,
        oauth_generation: &str,
        adapter: &dyn ProviderAccountAdapter,
        oauth_identity: &VerifiedClaudeOAuthIdentity,
        broker: &Arc<BrowserSessionBroker>,
        cancellation: &CancellationToken,
    ) -> Option<(ClaudeTeamEnrichment, String, u64)> {
        if let Some(session_ref) = binding
            .session_ref
            .as_deref()
            .filter(|session_ref| session_matches(broker, binding, session_ref))
        {
            let enrichment =
                broker.refresh_claude_enrichment(session_ref, oauth_identity, cancellation);
            if enrichment.warning != Some(ClaudeTeamWarningCode::SessionUnavailable) {
                let generation = enrichment.credential_generation().unwrap_or(0);
                return Some((enrichment, session_ref.to_string(), generation));
            }
        }
        self.reacquire_claude_session(
            binding,
            oauth_connection_id,
            oauth_connection_key,
            oauth_generation,
            adapter,
            oauth_identity,
            broker,
            cancellation,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn reacquire_claude_session(
        &self,
        binding: &ClaudeBrowserBinding,
        oauth_connection_id: &str,
        oauth_connection_key: &str,
        oauth_generation: &str,
        adapter: &dyn ProviderAccountAdapter,
        oauth_identity: &VerifiedClaudeOAuthIdentity,
        broker: &Arc<BrowserSessionBroker>,
        cancellation: &CancellationToken,
    ) -> Option<(ClaudeTeamEnrichment, String, u64)> {
        let discovery = broker.discover_claude_specific(
            binding.browser,
            &binding.connection_key,
            oauth_identity,
            cancellation,
        );
        let candidate = discovery.profile.candidate?;
        let claim = broker.claim_candidate(&candidate.candidate_id).ok()?;
        if claim.provider() != CookieProvider::Claude
            || claim.browser() != binding.browser
            || claim.profile_key() != binding.connection_key
            || adapter
                .credential_generation(oauth_connection_key)
                .ok()
                .as_deref()
                != Some(oauth_generation)
        {
            broker.release_session(claim.session_ref());
            return None;
        }
        let session_ref = claim.session_ref().to_string();
        let credential = match broker.session_credential(&session_ref) {
            Ok(credential) => credential,
            Err(_) => {
                broker.release_session(&session_ref);
                return None;
            }
        };
        let generation = credential.generation();
        drop(credential);
        let replaced = match self.install_claude_session(
            binding,
            oauth_connection_id,
            oauth_connection_key,
            &session_ref,
        ) {
            Some(replaced) => replaced,
            None => {
                broker.release_session(&session_ref);
                return None;
            }
        };
        if let Some(replaced) = replaced.filter(|replaced| replaced != &session_ref) {
            broker.release_session(&replaced);
        }
        Some((discovery.enrichment, session_ref, generation))
    }

    fn claude_browser_binding(
        &self,
        account_id: &str,
        oauth_connection_id: &str,
        oauth_connection_key: &str,
    ) -> Option<ClaudeBrowserBinding> {
        let providers = self.providers.lock().ok()?;
        let provider = providers.get("claude")?;
        if provider.active_account_id.as_deref() != Some(account_id) {
            return None;
        }
        let account = provider
            .accounts
            .iter()
            .find(|account| account.account_id == account_id)?;
        if !oauth_connection_is_current(
            account.connections.as_slice(),
            oauth_connection_id,
            oauth_connection_key,
        ) {
            return None;
        }
        let connection = account
            .connections
            .iter()
            .filter(|connection| {
                connection.attached
                    && matches!(
                        connection.kind,
                        ConnectionKind::Chrome | ConnectionKind::Arc
                    )
            })
            .min_by_key(|connection| {
                (
                    !(connection.available && connection.session_ref.is_some()),
                    connection.kind,
                    connection.connection_key.as_str(),
                )
            })?;
        Some(ClaudeBrowserBinding {
            account_id: account_id.to_string(),
            connection_id: connection.connection_id.clone(),
            connection_key: connection.connection_key.clone(),
            browser: browser_for_kind(connection.kind)?,
            session_ref: connection.session_ref.clone(),
        })
    }

    fn install_claude_session(
        &self,
        binding: &ClaudeBrowserBinding,
        oauth_connection_id: &str,
        oauth_connection_key: &str,
        session_ref: &str,
    ) -> Option<Option<String>> {
        let mut providers = self.providers.lock().ok()?;
        let provider = providers.get_mut("claude")?;
        if provider.active_account_id.as_deref() != Some(binding.account_id.as_str()) {
            return None;
        }
        let account = provider
            .accounts
            .iter_mut()
            .find(|account| account.account_id == binding.account_id)?;
        if !oauth_connection_is_current(
            account.connections.as_slice(),
            oauth_connection_id,
            oauth_connection_key,
        ) {
            return None;
        }
        let connection = account.connections.iter_mut().find(|connection| {
            connection.connection_id == binding.connection_id
                && connection.connection_key == binding.connection_key
                && connection.attached
                && browser_for_kind(connection.kind) == Some(binding.browser)
        })?;
        connection.available = true;
        Some(connection.session_ref.replace(session_ref.to_string()))
    }
}

fn oauth_connection_is_current(
    connections: &[ConnectionRecord],
    connection_id: &str,
    connection_key: &str,
) -> bool {
    connections.iter().any(|connection| {
        connection.connection_id == connection_id
            && connection.connection_key == connection_key
            && connection.kind == ConnectionKind::Cli
            && connection.attached
            && connection.available
    })
}

fn browser_for_kind(kind: ConnectionKind) -> Option<Browser> {
    match kind {
        ConnectionKind::Chrome => Some(Browser::Chrome),
        ConnectionKind::Arc => Some(Browser::Arc),
        ConnectionKind::Desktop | ConnectionKind::Cli => None,
    }
}

fn session_matches(
    broker: &BrowserSessionBroker,
    binding: &ClaudeBrowserBinding,
    session_ref: &str,
) -> bool {
    broker
        .session_binding(session_ref)
        .ok()
        .is_some_and(|session| {
            session.provider == CookieProvider::Claude
                && session.browser == binding.browser
                && session.profile_key == binding.connection_key
        })
}

fn warning_code(warning: ClaudeTeamWarningCode) -> &'static str {
    match warning {
        ClaudeTeamWarningCode::IdentityMismatch => "identityMismatch",
        ClaudeTeamWarningCode::MissingIdentity => "missingIdentity",
        ClaudeTeamWarningCode::UnknownSeat => "unknownSeat",
        ClaudeTeamWarningCode::ProviderUnavailable => "providerUnavailable",
        ClaudeTeamWarningCode::SessionUnavailable => "sessionUnavailable",
        ClaudeTeamWarningCode::CredentialsChanged => "browserCredentialsChanged",
        ClaudeTeamWarningCode::Cancelled => "cancelled",
    }
}

fn enrichment_warning(code: &str) -> ClaudeEnrichmentResult {
    ClaudeEnrichmentResult {
        lease: None,
        warning: Some(ProviderEnrichmentWarning {
            code: code.to_string(),
            message: warning_message(code).to_string(),
            correlation_id: uuid::Uuid::new_v4().to_string(),
        }),
    }
}

fn warning_message(code: &str) -> &'static str {
    match code {
        "identityMismatch" => {
            "The connected Claude browser profile does not match the selected OAuth account. Quota remains available with the generic Team label."
        }
        "missingIdentity" => {
            "The connected Claude browser profile did not provide enough identity information to verify the exact Team seat."
        }
        "unknownSeat" => {
            "The connected Claude Team seat is not recognized yet. Quota remains available with the generic Team label."
        }
        "browserProfileUnavailable" => {
            "Connect a matching Claude browser profile to verify the exact Team seat."
        }
        "oauthCredentialsChanged" | "browserCredentialsChanged" => {
            "Claude credentials changed during Team seat verification. Refresh again."
        }
        "oauthIdentityUnavailable" => {
            "Claude OAuth identity is unavailable, so the exact Team seat could not be verified."
        }
        "browserBrokerUnavailable" | "providerUnavailable" | "sessionUnavailable" => {
            "Claude Team seat verification is temporarily unavailable. Quota remains available with the generic Team label."
        }
        "cancelled" => "Claude Team seat verification was cancelled. Refresh again.",
        _ => {
            "Claude Team seat verification is unavailable. Quota remains available with the generic Team label."
        }
    }
}
