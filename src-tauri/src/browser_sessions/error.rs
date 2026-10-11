use super::ProcessRunError;
use super::protocol::HelperErrorCode;
use super::transport::ProviderTransportError;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BrowserSessionErrorCode {
    InvalidProfileKey,
    TimedOut,
    OutputTooLarge,
    HelperFailed,
    InvalidResponse,
    ProfileDiscoveryFailed,
    CookieReadFailed,
    Cancelled,
    ProviderValidationFailed,
    AuthenticationRejected,
    IdentityUnavailable,
    CandidateNotFound,
    CandidateExpired,
    SessionNotFound,
    OverallTimedOut,
    UnsupportedProvider,
    InvalidRequest,
    WorkerFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSessionError {
    pub code: BrowserSessionErrorCode,
    pub message: &'static str,
}

impl BrowserSessionError {
    /// Rejects ambiguous profile selection before any profile's cookies can be read.
    pub(super) fn invalid_profile_key() -> Self {
        Self {
            code: BrowserSessionErrorCode::InvalidProfileKey,
            message: "Choose one exact browser profile.",
        }
    }

    /// Reports helper failure without exposing subprocess output or local paths.
    pub(super) fn helper_failed() -> Self {
        Self {
            code: BrowserSessionErrorCode::HelperFailed,
            message: "The browser helper could not complete this request.",
        }
    }

    /// Preserves bounded subprocess failure categories while discarding raw process details.
    pub(super) fn from_process(error: ProcessRunError) -> Self {
        match error {
            ProcessRunError::TimedOut => Self {
                code: BrowserSessionErrorCode::TimedOut,
                message: "The browser helper timed out.",
            },
            ProcessRunError::OutputTooLarge => Self {
                code: BrowserSessionErrorCode::OutputTooLarge,
                message: "The browser helper returned too much data.",
            },
            ProcessRunError::Failed => Self::helper_failed(),
        }
    }

    /// Marks a helper protocol violation without returning its potentially sensitive payload.
    pub(super) fn invalid_response() -> Self {
        Self {
            code: BrowserSessionErrorCode::InvalidResponse,
            message: "The browser helper returned an invalid response.",
        }
    }

    /// Keeps expected discovery/read failures distinct and treats impossible helper codes as invalid.
    pub(super) fn from_helper(code: HelperErrorCode) -> Self {
        match code {
            HelperErrorCode::ProfileDiscoveryFailed => Self {
                code: BrowserSessionErrorCode::ProfileDiscoveryFailed,
                message: "Browser profiles could not be listed.",
            },
            HelperErrorCode::CookieReadFailed => Self {
                code: BrowserSessionErrorCode::CookieReadFailed,
                message: "Browser cookies could not be read.",
            },
            HelperErrorCode::UnsupportedVersion
            | HelperErrorCode::InvalidRequest
            | HelperErrorCode::UnsupportedBrowser
            | HelperErrorCode::UnsupportedProvider
            | HelperErrorCode::InvalidProfileKey
            | HelperErrorCode::UnsupportedOperation => Self::invalid_response(),
        }
    }

    /// Gives cancellation its own receipt instead of presenting it as authentication failure.
    pub(super) fn cancelled() -> Self {
        Self {
            code: BrowserSessionErrorCode::Cancelled,
            message: "Browser discovery was cancelled.",
        }
    }

    /// Reports unsuccessful verification without claiming that credentials were rejected.
    pub(crate) fn provider_validation_failed() -> Self {
        Self {
            code: BrowserSessionErrorCode::ProviderValidationFailed,
            message: "The browser session could not be verified.",
        }
    }

    /// Reports that no isolated cookie candidate authenticated, without exposing candidate contents.
    pub(super) fn authentication_rejected() -> Self {
        Self {
            code: BrowserSessionErrorCode::AuthenticationRejected,
            message: "No signed-in account could be verified in this profile.",
        }
    }

    /// Distinguishes unusable account identity evidence from rejected authentication for recovery.
    pub(super) fn identity_unavailable() -> Self {
        Self {
            code: BrowserSessionErrorCode::IdentityUnavailable,
            message: "The browser account identity could not be confirmed.",
        }
    }

    /// Treats consumed and missing candidates alike so attachment cannot retry an old claim.
    pub(super) fn candidate_not_found() -> Self {
        Self {
            code: BrowserSessionErrorCode::CandidateNotFound,
            message: "This browser account candidate is no longer available.",
        }
    }

    /// Requires a new profile check after the candidate's bounded lifetime ends.
    pub(super) fn candidate_expired() -> Self {
        Self {
            code: BrowserSessionErrorCode::CandidateExpired,
            message: "This browser account candidate expired. Scan the profile again.",
        }
    }

    /// Reports unavailable session state without revealing whether it expired or was released.
    pub(super) fn session_not_found() -> Self {
        Self {
            code: BrowserSessionErrorCode::SessionNotFound,
            message: "This browser session is no longer available.",
        }
    }

    /// Separates the shared profile-scan deadline from an individual request timeout.
    pub(super) fn overall_timed_out() -> Self {
        Self {
            code: BrowserSessionErrorCode::OverallTimedOut,
            message: "Browser profile discovery timed out.",
        }
    }

    /// Rejects providers outside the broker's supported browser-account contract.
    pub(crate) fn unsupported_provider() -> Self {
        Self {
            code: BrowserSessionErrorCode::UnsupportedProvider,
            message: "Browser accounts are unavailable for this provider.",
        }
    }

    /// Returns a safe boundary error when an account request cannot be interpreted.
    pub(crate) fn invalid_request() -> Self {
        Self {
            code: BrowserSessionErrorCode::InvalidRequest,
            message: "The browser account request is invalid.",
        }
    }

    /// Makes unexpected worker termination visible as a retryable failure receipt.
    pub(crate) fn worker_failed() -> Self {
        Self {
            code: BrowserSessionErrorCode::WorkerFailed,
            message: "Browser account discovery stopped unexpectedly. Try again.",
        }
    }

    /// Preserves cancellation and timeout while hiding network, status, and response details.
    pub(super) fn from_transport(error: ProviderTransportError) -> Self {
        match error {
            ProviderTransportError::Cancelled => Self::cancelled(),
            ProviderTransportError::Timeout => Self {
                code: BrowserSessionErrorCode::TimedOut,
                message: "Browser account verification timed out.",
            },
            ProviderTransportError::Network
            | ProviderTransportError::Redirect
            | ProviderTransportError::InvalidResponse
            | ProviderTransportError::HttpStatus(_)
            | ProviderTransportError::UnsupportedProvider => Self::provider_validation_failed(),
        }
    }
}

impl std::fmt::Display for BrowserSessionError {
    /// Formats only the fixed user-facing message, never underlying credential-bearing details.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for BrowserSessionError {}
