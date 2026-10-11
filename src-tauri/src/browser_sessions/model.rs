use super::{Browser, BrowserSessionError, CookieProvider};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountIdentityDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<AccountIdentityDisplay>,
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
    /// Logs only the typed failure code and returns a receipt with no attachable candidate.
    pub(super) fn failed(profile_key: &str, error: BrowserSessionError) -> Self {
        log::warn!("Browser account check failed: code={:?}", error.code);
        Self {
            profile_key: profile_key.to_string(),
            status: ProfileDiscoveryStatus::Failed,
            candidate: None,
            error: Some(error),
        }
    }

    /// Records a completed profile check that found no cookie candidates, without implying failure.
    pub(super) fn empty(profile_key: &str) -> Self {
        Self {
            profile_key: profile_key.to_string(),
            status: ProfileDiscoveryStatus::Empty,
            candidate: None,
            error: None,
        }
    }

    /// Publishes already-verified candidate metadata without exposing its retained credentials.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<AccountIdentityDisplay>,
}

pub(crate) struct AttachedSessionClaim {
    handle: SessionRefHandle,
    provider: CookieProvider,
    browser: Browser,
    profile_key: String,
    normalized_identity: String,
}

impl AttachedSessionClaim {
    /// Holds source metadata and an opaque identity for a session already claimed from the roster.
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

    /// Borrows the broker reference used to retain or release this claim's session.
    pub(crate) fn session_ref(&self) -> &str {
        &self.handle.session_ref
    }

    /// Identifies the verified provider so attachment can reject a cross-provider claim.
    pub(crate) fn provider(&self) -> CookieProvider {
        self.provider
    }

    /// Identifies the source browser used to assign the connection kind.
    pub(crate) fn browser(&self) -> Browser {
        self.browser
    }

    /// Borrows the exact source profile used to replace or reconnect its account connection.
    pub(crate) fn profile_key(&self) -> &str {
        &self.profile_key
    }

    /// Borrows the opaque identity for fingerprinting; it must not be serialized or logged.
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
    /// Erases the claim's identity copy without releasing the separately owned broker session.
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
    /// Owns a credential snapshot and its rotation generation until both secret buffers are dropped.
    pub(super) fn new(cookie_header: String, normalized_identity: String, generation: u64) -> Self {
        Self {
            cookie_header,
            normalized_identity,
            generation,
        }
    }

    /// Borrows cookies for internal provider requests; callers must keep them out of receipts.
    pub(crate) fn cookie_header(&self) -> &str {
        &self.cookie_header
    }

    /// Borrows the session identity used to recheck the selected OAuth binding.
    pub(crate) fn normalized_identity(&self) -> &str {
        &self.normalized_identity
    }

    /// Returns the snapshot revision needed to reject enrichment after concurrent cookie rotation.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for BrokerSessionCredential {
    /// Overwrites both credential and identity copies before their allocations are released.
    fn drop(&mut self) {
        unsafe {
            self.cookie_header.as_bytes_mut().fill(0);
            self.normalized_identity.as_bytes_mut().fill(0);
        }
    }
}
