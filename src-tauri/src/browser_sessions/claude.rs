use super::model::ProfileDiscoveryResult;
use super::roster::{CandidateInput, SecretValue};
use super::{
    Browser, BrowserSessionBroker, CancellationToken, ClaudeAccountEvidence,
    ClaudeAccountTransportError, CookieProvider, VerifiedIdentity,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

const CLAUDE_ACCOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const CLAUDE_COOKIE_READ_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct VerifiedClaudeOAuthIdentity {
    email: SecretValue,
    organization_uuid: SecretValue,
}

impl VerifiedClaudeOAuthIdentity {
    /// Normalizes bounded OAuth identity fields and erases both original input buffers.
    pub(crate) fn new(mut email: String, mut organization_uuid: String) -> Option<Self> {
        let normalized_email = normalize_email(&email).map(SecretValue::new);
        let exact_organization_uuid =
            exact_organization_uuid(&organization_uuid).map(SecretValue::new);
        zero_string(&mut email);
        zero_string(&mut organization_uuid);
        match (normalized_email, exact_organization_uuid) {
            (Some(email), Some(organization_uuid)) => Some(Self {
                email,
                organization_uuid,
            }),
            _ => None,
        }
    }

    /// Pairs the opaque OAuth binding with its verified email for account display.
    fn binding_identity(&self) -> VerifiedIdentity {
        VerifiedIdentity::new(self.binding_token())
            .expect("Claude binding digest is valid")
            .with_display(Some(self.email.expose().to_string()), None)
            .expect("verified Claude email is present")
    }

    /// Returns a stable binding digest without exposing the email or organization UUID.
    pub(crate) fn opaque_identity(&self) -> String {
        self.binding_token()
    }

    /// Requires the session binding to identify this exact normalized email and organization pair.
    fn matches_binding(&self, binding: &str) -> bool {
        self.binding_token() == binding
    }

    /// Hashes a domain-separated, length-delimited identity pair to prevent ambiguous bindings.
    fn binding_token(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"openusage-claude-oauth-v1\0");
        hasher.update((self.email.expose().len() as u64).to_be_bytes());
        hasher.update(self.email.expose().as_bytes());
        hasher.update((self.organization_uuid.expose().len() as u64).to_be_bytes());
        hasher.update(self.organization_uuid.expose().as_bytes());
        let digest = hasher.finalize();
        let mut token = String::with_capacity("claude:".len() + digest.len() * 2);
        token.push_str("claude:");
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in digest {
            token.push(HEX[(byte >> 4) as usize] as char);
            token.push(HEX[(byte & 0x0f) as usize] as char);
        }
        token
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClaudeTeamPlan {
    Team,
    TeamStandard,
    TeamPremium,
}

impl ClaudeTeamPlan {
    /// Keeps an unknown Team seat generic instead of claiming a verified seat tier.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Team => "Team",
            Self::TeamStandard => "Claude Team Standard",
            Self::TeamPremium => "Claude Team Premium",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClaudeTeamWarningCode {
    IdentityMismatch,
    MissingIdentity,
    UnknownSeat,
    ProviderUnavailable,
    SessionUnavailable,
    CredentialsChanged,
    Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeTeamEnrichment {
    pub plan: ClaudeTeamPlan,
    pub exact: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<ClaudeTeamWarningCode>,
    #[serde(skip)]
    credential_generation: Option<u64>,
}

impl ClaudeTeamEnrichment {
    /// Exposes the accepted credential revision only for exact enrichment results.
    pub(crate) fn credential_generation(&self) -> Option<u64> {
        self.credential_generation
    }

    /// Preserves a typed warning without asserting an exact seat or credential revision.
    fn generic(warning: ClaudeTeamWarningCode) -> Self {
        Self {
            plan: ClaudeTeamPlan::Team,
            exact: false,
            warning: Some(warning),
            credential_generation: None,
        }
    }

    /// Records a verified seat tier; a refresh must separately bind it to a credential revision.
    fn exact(plan: ClaudeTeamPlan) -> Self {
        Self {
            plan,
            exact: true,
            warning: None,
            credential_generation: None,
        }
    }

    /// Binds exact enrichment to the credential revision accepted by the roster.
    fn with_credential_generation(mut self, generation: u64) -> Self {
        if self.exact {
            self.credential_generation = Some(generation);
        }
        self
    }

    /// Accepts a matched identity even when its seat tier is unknown, but rejects other warnings.
    fn proves_identity(&self) -> bool {
        self.exact || self.warning == Some(ClaudeTeamWarningCode::UnknownSeat)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeProfileDiscovery {
    pub profile: ProfileDiscoveryResult,
    pub enrichment: ClaudeTeamEnrichment,
}

impl BrowserSessionBroker {
    /// Retains a profile candidate only after its browser email and organization match OAuth.
    pub(crate) fn discover_claude_specific(
        &self,
        browser: Browser,
        profile_key: &str,
        oauth_identity: &VerifiedClaudeOAuthIdentity,
        cancellation: &CancellationToken,
    ) -> ClaudeProfileDiscovery {
        if cancellation.is_cancelled() {
            return failed_discovery(
                profile_key,
                super::BrowserSessionError::cancelled(),
                ClaudeTeamWarningCode::Cancelled,
            );
        }
        let mut response = match self.read_cookies_with_timeout(
            browser,
            profile_key,
            CookieProvider::Claude,
            CLAUDE_COOKIE_READ_TIMEOUT,
        ) {
            Ok(response) => response,
            Err(error) => {
                let warning = if cancellation.is_cancelled() {
                    ClaudeTeamWarningCode::Cancelled
                } else {
                    ClaudeTeamWarningCode::SessionUnavailable
                };
                return failed_discovery(profile_key, error, warning);
            }
        };
        if cancellation.is_cancelled() {
            zero_candidates(&mut response.candidates);
            return failed_discovery(
                profile_key,
                super::BrowserSessionError::cancelled(),
                ClaudeTeamWarningCode::Cancelled,
            );
        }
        if response.candidates.is_empty() {
            return ClaudeProfileDiscovery {
                profile: ProfileDiscoveryResult::empty(profile_key),
                enrichment: ClaudeTeamEnrichment::generic(
                    ClaudeTeamWarningCode::SessionUnavailable,
                ),
            };
        }

        let mut last_warning = ClaudeTeamWarningCode::SessionUnavailable;
        let mut candidates = response.candidates;
        candidates.reverse();
        while let Some(mut candidate) = candidates.pop() {
            if cancellation.is_cancelled() {
                zero_candidate(&mut candidate);
                zero_candidates(&mut candidates);
                return failed_discovery(
                    profile_key,
                    super::BrowserSessionError::cancelled(),
                    ClaudeTeamWarningCode::Cancelled,
                );
            }
            let evidence = match self.claude_transport.fetch_account(
                &candidate.cookie_header,
                CLAUDE_ACCOUNT_TIMEOUT,
                cancellation,
            ) {
                Ok(evidence) => evidence,
                Err(ClaudeAccountTransportError::Authentication) => {
                    zero_candidate(&mut candidate);
                    continue;
                }
                Err(ClaudeAccountTransportError::Cancelled) => {
                    zero_candidate(&mut candidate);
                    zero_candidates(&mut candidates);
                    return failed_discovery(
                        profile_key,
                        super::BrowserSessionError::cancelled(),
                        ClaudeTeamWarningCode::Cancelled,
                    );
                }
                Err(_) => {
                    zero_candidate(&mut candidate);
                    zero_candidates(&mut candidates);
                    return failed_discovery(
                        profile_key,
                        super::BrowserSessionError::provider_validation_failed(),
                        ClaudeTeamWarningCode::ProviderUnavailable,
                    );
                }
            };
            if cancellation.is_cancelled() {
                zero_candidate(&mut candidate);
                zero_candidates(&mut candidates);
                return failed_discovery(
                    profile_key,
                    super::BrowserSessionError::cancelled(),
                    ClaudeTeamWarningCode::Cancelled,
                );
            }
            let enrichment = resolve_claude_account(&evidence, oauth_identity);
            if !enrichment.proves_identity() {
                last_warning = enrichment
                    .warning
                    .unwrap_or(ClaudeTeamWarningCode::IdentityMismatch);
                zero_candidate(&mut candidate);
                continue;
            }

            if let Some(rotated) = evidence.rotated_cookie_header.as_ref() {
                zero_string(&mut candidate.cookie_header);
                candidate.cookie_header = rotated.expose().to_string();
            }
            let now = self.clock.now();
            let (store_id, host, cookie_header) = candidate.into_parts();
            let summary = self
                .roster
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert_candidate(
                    now,
                    CandidateInput {
                        provider: CookieProvider::Claude,
                        browser,
                        profile_key: profile_key.to_string(),
                        host,
                        store_id,
                        cookie_header,
                        identity: oauth_identity.binding_identity(),
                    },
                );
            zero_candidates(&mut candidates);
            return ClaudeProfileDiscovery {
                profile: ProfileDiscoveryResult::verified(profile_key, summary),
                enrichment,
            };
        }
        failed_discovery(
            profile_key,
            super::BrowserSessionError::authentication_rejected(),
            last_warning,
        )
    }

    /// Rechecks the OAuth binding and publishes enrichment only if the session credentials still match.
    pub(crate) fn refresh_claude_enrichment(
        &self,
        session_ref: &str,
        oauth_identity: &VerifiedClaudeOAuthIdentity,
        cancellation: &CancellationToken,
    ) -> ClaudeTeamEnrichment {
        if cancellation.is_cancelled() {
            return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::Cancelled);
        }
        match self.session_binding(session_ref) {
            Ok(binding) if binding.provider == CookieProvider::Claude => {}
            _ => {
                return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::SessionUnavailable);
            }
        }
        let credential = match self.session_credential(session_ref) {
            Ok(credential) => credential,
            Err(_) => {
                return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::SessionUnavailable);
            }
        };
        if !oauth_identity.matches_binding(credential.normalized_identity()) {
            return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::IdentityMismatch);
        }
        let evidence = match self.claude_transport.fetch_account(
            credential.cookie_header(),
            CLAUDE_ACCOUNT_TIMEOUT,
            cancellation,
        ) {
            Ok(evidence) => evidence,
            Err(error) => return transport_fallback(error),
        };
        if cancellation.is_cancelled() {
            return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::Cancelled);
        }
        let enrichment = resolve_claude_account(&evidence, oauth_identity);
        if !enrichment.proves_identity() {
            return enrichment;
        }
        let committed = self
            .roster
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commit_cookie_refresh(
                self.clock.now(),
                session_ref,
                CookieProvider::Claude,
                credential.generation(),
                credential.cookie_header(),
                evidence
                    .rotated_cookie_header
                    .as_ref()
                    .map(SecretValue::expose),
            );
        match committed {
            Ok(Some(generation)) => enrichment.with_credential_generation(generation),
            Ok(None) => ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::CredentialsChanged),
            Err(_) => ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::SessionUnavailable),
        }
    }
}

/// Requires both email and organization evidence before interpreting the matching seat tier.
pub(super) fn resolve_claude_account(
    evidence: &ClaudeAccountEvidence,
    oauth_identity: &VerifiedClaudeOAuthIdentity,
) -> ClaudeTeamEnrichment {
    let Some(email) = evidence.email.as_ref() else {
        return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::MissingIdentity);
    };
    let Some(mut email) = normalize_email(email.expose()) else {
        return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::MissingIdentity);
    };
    let email_matches = email == oauth_identity.email.expose();
    zero_string(&mut email);
    if !email_matches {
        return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::IdentityMismatch);
    }

    let mut saw_organization = false;
    let matching = evidence.memberships.iter().find(|membership| {
        let Some(organization_uuid) = membership.organization_uuid.as_ref() else {
            return false;
        };
        saw_organization = true;
        organization_uuid.expose() == oauth_identity.organization_uuid.expose()
    });
    let Some(membership) = matching else {
        return ClaudeTeamEnrichment::generic(if saw_organization {
            ClaudeTeamWarningCode::IdentityMismatch
        } else {
            ClaudeTeamWarningCode::MissingIdentity
        });
    };
    let Some(seat_tier) = membership.seat_tier.as_ref() else {
        return ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::UnknownSeat);
    };
    let seat_tier = seat_tier
        .expose()
        .trim_matches(|character: char| character.is_ascii_whitespace());
    if seat_tier.eq_ignore_ascii_case("team_standard") {
        ClaudeTeamEnrichment::exact(ClaudeTeamPlan::TeamStandard)
    } else if seat_tier.eq_ignore_ascii_case("team_tier_1") {
        ClaudeTeamEnrichment::exact(ClaudeTeamPlan::TeamPremium)
    } else {
        ClaudeTeamEnrichment::generic(ClaudeTeamWarningCode::UnknownSeat)
    }
}

/// Keeps a failed profile receipt and its non-exact enrichment warning together.
fn failed_discovery(
    profile_key: &str,
    error: super::BrowserSessionError,
    warning: ClaudeTeamWarningCode,
) -> ClaudeProfileDiscovery {
    ClaudeProfileDiscovery {
        profile: ProfileDiscoveryResult::failed(profile_key, error),
        enrichment: ClaudeTeamEnrichment::generic(warning),
    }
}

/// Maps transport failures to generic enrichment without retaining an exact seat claim.
fn transport_fallback(error: ClaudeAccountTransportError) -> ClaudeTeamEnrichment {
    ClaudeTeamEnrichment::generic(match error {
        ClaudeAccountTransportError::Cancelled => ClaudeTeamWarningCode::Cancelled,
        ClaudeAccountTransportError::Authentication => ClaudeTeamWarningCode::SessionUnavailable,
        ClaudeAccountTransportError::Timeout
        | ClaudeAccountTransportError::Network
        | ClaudeAccountTransportError::Redirect
        | ClaudeAccountTransportError::InvalidResponse
        | ClaudeAccountTransportError::HttpStatus(_) => ClaudeTeamWarningCode::ProviderUnavailable,
    })
}

/// Erases credentials for every candidate abandoned by discovery.
fn zero_candidates(candidates: &mut [super::protocol::CookieCandidate]) {
    for candidate in candidates {
        zero_candidate(candidate);
    }
}

/// Erases the candidate's store identifier and cookie buffer while leaving source metadata intact.
fn zero_candidate(candidate: &mut super::protocol::CookieCandidate) {
    zero_string(&mut candidate.store_id);
    zero_string(&mut candidate.cookie_header);
}

/// Overwrites the occupied buffer before clearing the string.
fn zero_string(value: &mut String) {
    unsafe { value.as_bytes_mut().fill(0) };
    value.clear();
}

/// Trims and ASCII-folds a bounded, control-free email value used for identity matching.
fn normalize_email(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    (normalized.len() <= 254 && valid_secret_field(&normalized)).then_some(normalized)
}

/// Preserves an exact bounded organization identifier and rejects surrounding ASCII whitespace.
fn exact_organization_uuid(value: &str) -> Option<String> {
    (value == value.trim_matches(|character: char| character.is_ascii_whitespace())
        && valid_secret_field(value))
    .then(|| value.to_string())
}

/// Restricts identity fields to nonempty bounded values without control characters.
fn valid_secret_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
