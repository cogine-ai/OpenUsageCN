use super::{Browser, BrowserSessionError, CookieProvider};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProfileDiscoveryStatus {
    Verified,
    Empty,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserCandidateSummary {
    pub candidate_id: String,
    pub provider: CookieProvider,
    pub browser: Browser,
    pub profile_key: String,
    pub host: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDiscoveryResult {
    pub profile_key: String,
    pub status: ProfileDiscoveryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<BrowserCandidateSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserSessionError>,
}

impl ProfileDiscoveryResult {
    pub(super) fn failed(profile_key: &str, error: BrowserSessionError) -> Self {
        Self {
            profile_key: profile_key.to_string(),
            status: ProfileDiscoveryStatus::Failed,
            candidate: None,
            error: Some(error),
        }
    }

    pub(super) fn empty(profile_key: &str) -> Self {
        Self {
            profile_key: profile_key.to_string(),
            status: ProfileDiscoveryStatus::Empty,
            candidate: None,
            error: None,
        }
    }

    pub(super) fn verified(profile_key: &str, candidate: BrowserCandidateSummary) -> Self {
        Self {
            profile_key: profile_key.to_string(),
            status: ProfileDiscoveryStatus::Verified,
            candidate: Some(candidate),
            error: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AllProfilesDiscovery {
    pub browser: Browser,
    pub provider: CookieProvider,
    pub profiles: Vec<ProfileDiscoveryResult>,
    pub partial: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRefHandle {
    pub session_ref: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBindingSummary {
    pub provider: CookieProvider,
    pub browser: Browser,
    pub profile_key: String,
    pub host: String,
    pub expires_at_ms: u64,
}

pub(crate) struct AttachedSessionClaim {
    handle: SessionRefHandle,
    provider: CookieProvider,
    browser: Browser,
    profile_key: String,
    normalized_identity: String,
}

impl AttachedSessionClaim {
    pub(super) fn new(
        handle: SessionRefHandle,
        provider: CookieProvider,
        browser: Browser,
        profile_key: String,
        normalized_identity: String,
    ) -> Self {
        Self {
            handle,
            provider,
            browser,
            profile_key,
            normalized_identity,
        }
    }

    pub(crate) fn session_ref(&self) -> &str {
        &self.handle.session_ref
    }

    pub(crate) fn provider(&self) -> CookieProvider {
        self.provider
    }

    pub(crate) fn browser(&self) -> Browser {
        self.browser
    }

    pub(crate) fn profile_key(&self) -> &str {
        &self.profile_key
    }

    pub(crate) fn normalized_identity(&self) -> &str {
        &self.normalized_identity
    }

    #[cfg(test)]
    pub(super) fn into_handle(mut self) -> SessionRefHandle {
        unsafe { self.normalized_identity.as_bytes_mut().fill(0) };
        self.normalized_identity.clear();
        self.handle.clone()
    }
}

impl Drop for AttachedSessionClaim {
    fn drop(&mut self) {
        unsafe { self.normalized_identity.as_bytes_mut().fill(0) };
    }
}

pub(crate) struct BrokerSessionCredential {
    cookie_header: String,
    normalized_identity: String,
    generation: u64,
}

impl BrokerSessionCredential {
    pub(super) fn new(cookie_header: String, normalized_identity: String, generation: u64) -> Self {
        Self {
            cookie_header,
            normalized_identity,
            generation,
        }
    }

    pub(crate) fn cookie_header(&self) -> &str {
        &self.cookie_header
    }

    pub(crate) fn normalized_identity(&self) -> &str {
        &self.normalized_identity
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for BrokerSessionCredential {
    fn drop(&mut self) {
        unsafe {
            self.cookie_header.as_bytes_mut().fill(0);
            self.normalized_identity.as_bytes_mut().fill(0);
        }
    }
}
