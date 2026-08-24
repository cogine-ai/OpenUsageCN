use super::model::{
    AttachedSessionClaim, BrokerSessionCredential, BrowserCandidateSummary, SessionBindingSummary,
    SessionRefHandle,
};
use super::{Browser, BrowserSessionError, ClockReading, CookieProvider, VerifiedIdentity};
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

const CANDIDATE_TTL: Duration = Duration::from_secs(10 * 60);

pub(super) struct SecretValue(String);

impl SecretValue {
    pub(super) fn new(value: String) -> Self {
        Self(value)
    }

    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        unsafe { self.0.as_bytes_mut().fill(0) };
    }
}

pub(super) struct CandidateInput {
    pub provider: CookieProvider,
    pub browser: Browser,
    pub profile_key: String,
    pub host: String,
    pub store_id: String,
    pub cookie_header: String,
    pub identity: VerifiedIdentity,
}

struct CandidateEntry {
    provider: CookieProvider,
    browser: Browser,
    profile_key: String,
    host: String,
    store_id: SecretValue,
    cookie_header: SecretValue,
    identity: SecretValue,
    expires_monotonic: Duration,
    expires_at_ms: u64,
}

struct SessionEntry {
    provider: CookieProvider,
    browser: Browser,
    profile_key: String,
    host: String,
    store_id: SecretValue,
    cookie_header: SecretValue,
    identity: SecretValue,
    credential_generation: u64,
    expires_monotonic: Duration,
    expires_at_ms: u64,
}

#[derive(Default)]
pub(super) struct BrokerRoster {
    candidates: HashMap<String, CandidateEntry>,
    sessions: HashMap<String, SessionEntry>,
}

impl BrokerRoster {
    pub(super) fn insert_candidate(
        &mut self,
        now: ClockReading,
        input: CandidateInput,
    ) -> BrowserCandidateSummary {
        self.prune(now.monotonic);
        let candidate_id = Uuid::new_v4().to_string();
        let expires_monotonic = now.monotonic.saturating_add(CANDIDATE_TTL);
        let expires_at_ms = now.unix_ms.saturating_add(10 * 60 * 1_000);
        let summary = BrowserCandidateSummary {
            candidate_id: candidate_id.clone(),
            provider: input.provider,
            browser: input.browser,
            profile_key: input.profile_key.clone(),
            host: input.host.clone(),
            expires_at_ms,
        };
        self.candidates.insert(
            candidate_id,
            CandidateEntry {
                provider: input.provider,
                browser: input.browser,
                profile_key: input.profile_key,
                host: input.host,
                store_id: SecretValue::new(input.store_id),
                cookie_header: SecretValue::new(input.cookie_header),
                identity: SecretValue::new(input.identity.into_inner()),
                expires_monotonic,
                expires_at_ms,
            },
        );
        summary
    }

    pub(super) fn attach(
        &mut self,
        now: ClockReading,
        candidate_id: &str,
    ) -> Result<AttachedSessionClaim, BrowserSessionError> {
        let Some(candidate) = self.candidates.remove(candidate_id) else {
            return Err(BrowserSessionError::candidate_not_found());
        };
        if now.monotonic >= candidate.expires_monotonic {
            return Err(BrowserSessionError::candidate_expired());
        }
        let session_ref = Uuid::new_v4().to_string();
        let handle = SessionRefHandle {
            session_ref: session_ref.clone(),
            expires_at_ms: candidate.expires_at_ms,
        };
        let claim = AttachedSessionClaim::new(
            handle,
            candidate.provider,
            candidate.browser,
            candidate.profile_key.clone(),
            candidate.identity.expose().to_string(),
        );
        self.sessions.insert(
            session_ref,
            SessionEntry {
                provider: candidate.provider,
                browser: candidate.browser,
                profile_key: candidate.profile_key,
                host: candidate.host,
                store_id: candidate.store_id,
                cookie_header: candidate.cookie_header,
                identity: candidate.identity,
                credential_generation: 0,
                expires_monotonic: candidate.expires_monotonic,
                expires_at_ms: candidate.expires_at_ms,
            },
        );
        Ok(claim)
    }

    pub(super) fn binding(
        &mut self,
        now: ClockReading,
        session_ref: &str,
    ) -> Result<SessionBindingSummary, BrowserSessionError> {
        self.prune(now.monotonic);
        let session = self
            .sessions
            .get(session_ref)
            .ok_or_else(BrowserSessionError::session_not_found)?;
        let _ = (
            session.store_id.expose(),
            session.cookie_header.expose(),
            session.identity.expose(),
        );
        Ok(SessionBindingSummary {
            provider: session.provider,
            browser: session.browser,
            profile_key: session.profile_key.clone(),
            host: session.host.clone(),
            expires_at_ms: session.expires_at_ms,
        })
    }

    pub(super) fn credential(
        &mut self,
        now: ClockReading,
        session_ref: &str,
    ) -> Result<BrokerSessionCredential, BrowserSessionError> {
        self.prune(now.monotonic);
        let session = self
            .sessions
            .get(session_ref)
            .ok_or_else(BrowserSessionError::session_not_found)?;
        Ok(BrokerSessionCredential::new(
            session.cookie_header.expose().to_string(),
            session.identity.expose().to_string(),
            session.credential_generation,
        ))
    }

    pub(super) fn commit_cookie_refresh(
        &mut self,
        now: ClockReading,
        session_ref: &str,
        provider: CookieProvider,
        expected_generation: u64,
        expected_cookie_header: &str,
        rotated_cookie_header: Option<&str>,
    ) -> Result<Option<u64>, BrowserSessionError> {
        self.prune(now.monotonic);
        let session = self
            .sessions
            .get_mut(session_ref)
            .ok_or_else(BrowserSessionError::session_not_found)?;
        if session.provider != provider
            || session.credential_generation != expected_generation
            || session.cookie_header.expose() != expected_cookie_header
        {
            return Ok(None);
        }
        if let Some(rotated_cookie_header) = rotated_cookie_header {
            if session.cookie_header.expose() != rotated_cookie_header {
                session.cookie_header = SecretValue::new(rotated_cookie_header.to_string());
                session.credential_generation = session.credential_generation.saturating_add(1);
            }
        }
        Ok(Some(session.credential_generation))
    }

    pub(super) fn release(&mut self, session_ref: &str) -> bool {
        self.sessions.remove(session_ref).is_some()
    }

    #[cfg(test)]
    pub(super) fn retained_session_count(&self) -> usize {
        self.sessions.len()
    }

    fn prune(&mut self, now: Duration) {
        self.candidates
            .retain(|_, candidate| now < candidate.expires_monotonic);
        self.sessions
            .retain(|_, session| now < session.expires_monotonic);
    }
}
