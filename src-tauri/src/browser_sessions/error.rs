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
    pub(super) fn invalid_profile_key() -> Self {
        Self {
            code: BrowserSessionErrorCode::InvalidProfileKey,
            message: "Choose one exact browser profile.",
        }
    }

    pub(super) fn helper_failed() -> Self {
        Self {
            code: BrowserSessionErrorCode::HelperFailed,
            message: "The browser helper could not complete this request.",
        }
    }

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

    pub(super) fn invalid_response() -> Self {
        Self {
            code: BrowserSessionErrorCode::InvalidResponse,
            message: "The browser helper returned an invalid response.",
        }
    }

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

    pub(super) fn cancelled() -> Self {
        Self {
            code: BrowserSessionErrorCode::Cancelled,
            message: "Browser discovery was cancelled.",
        }
    }

    pub(crate) fn provider_validation_failed() -> Self {
        Self {
            code: BrowserSessionErrorCode::ProviderValidationFailed,
            message: "The browser session could not be verified.",
        }
    }

    pub(super) fn authentication_rejected() -> Self {
        Self {
            code: BrowserSessionErrorCode::AuthenticationRejected,
            message: "No signed-in account could be verified in this profile.",
        }
    }

    pub(super) fn candidate_not_found() -> Self {
        Self {
            code: BrowserSessionErrorCode::CandidateNotFound,
            message: "This browser account candidate is no longer available.",
        }
    }

    pub(super) fn candidate_expired() -> Self {
        Self {
            code: BrowserSessionErrorCode::CandidateExpired,
            message: "This browser account candidate expired. Scan the profile again.",
        }
    }

    pub(super) fn session_not_found() -> Self {
        Self {
            code: BrowserSessionErrorCode::SessionNotFound,
            message: "This browser session is no longer available.",
        }
    }

    pub(super) fn overall_timed_out() -> Self {
        Self {
            code: BrowserSessionErrorCode::OverallTimedOut,
            message: "Browser profile discovery timed out.",
        }
    }

    pub(crate) fn unsupported_provider() -> Self {
        Self {
            code: BrowserSessionErrorCode::UnsupportedProvider,
            message: "Browser accounts are unavailable for this provider.",
        }
    }

    pub(crate) fn invalid_request() -> Self {
        Self {
            code: BrowserSessionErrorCode::InvalidRequest,
            message: "The browser account request is invalid.",
        }
    }

    pub(crate) fn worker_failed() -> Self {
        Self {
            code: BrowserSessionErrorCode::WorkerFailed,
            message: "Browser account discovery stopped unexpectedly. Try again.",
        }
    }

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
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for BrowserSessionError {}
