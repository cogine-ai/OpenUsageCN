use super::{CancellationToken, CookieProvider};
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

pub(super) const CURSOR_AUTH_URL: &str = "https://cursor.com/api/auth/me";
pub(super) const CURSOR_ORIGIN: &str = "https://cursor.com";
const MAX_IDENTITY_BODY: u64 = 1024 * 1024;

pub(crate) struct VerifiedIdentity(String);

impl VerifiedIdentity {
    pub(crate) fn new(mut value: String) -> Option<Self> {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.len() > 512 || trimmed.chars().any(char::is_control) {
            unsafe { value.as_bytes_mut().fill(0) };
            return None;
        }
        if trimmed.len() == value.len() {
            return Some(Self(value));
        }
        let normalized = trimmed.to_string();
        unsafe { value.as_bytes_mut().fill(0) };
        Some(Self(normalized))
    }

    #[cfg(test)]
    pub(super) fn expose(&self) -> &str {
        &self.0
    }

    pub(super) fn into_inner(mut self) -> String {
        std::mem::take(&mut self.0)
    }
}

impl Drop for VerifiedIdentity {
    fn drop(&mut self) {
        unsafe { self.0.as_bytes_mut().fill(0) };
    }
}

pub(crate) enum ValidationOutcome {
    Verified(VerifiedIdentity),
    RejectedAuthentication,
    MissingIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderTransportError {
    Cancelled,
    Timeout,
    Network,
    Redirect,
    InvalidResponse,
    HttpStatus(u16),
    UnsupportedProvider,
}

pub(crate) trait ProviderIdentityTransport: Send + Sync {
    fn validate(
        &self,
        provider: CookieProvider,
        cookie_header: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError>;
}

pub(super) struct FixedProviderIdentityTransport;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CursorStatusAction {
    ReadIdentity,
    RejectedAuthentication,
}

impl ProviderIdentityTransport for FixedProviderIdentityTransport {
    fn validate(
        &self,
        provider: CookieProvider,
        cookie_header: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        if provider != CookieProvider::Cursor {
            return Err(ProviderTransportError::UnsupportedProvider);
        }
        if cancellation.is_cancelled() {
            return Err(ProviderTransportError::Cancelled);
        }
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout)
            .timeout(timeout)
            .build()
            .map_err(|_| ProviderTransportError::Network)?;
        let response = client
            .get(CURSOR_AUTH_URL)
            .header(reqwest::header::ORIGIN, CURSOR_ORIGIN)
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .map_err(map_request_error)?;
        if cancellation.is_cancelled() {
            return Err(ProviderTransportError::Cancelled);
        }
        match classify_cursor_status(response.status().as_u16())? {
            CursorStatusAction::RejectedAuthentication => {
                return Ok(ValidationOutcome::RejectedAuthentication);
            }
            CursorStatusAction::ReadIdentity => {}
        }
        decode_cursor_identity(response, cancellation)
    }
}

fn map_request_error(error: reqwest::Error) -> ProviderTransportError {
    if error.is_timeout() {
        ProviderTransportError::Timeout
    } else {
        ProviderTransportError::Network
    }
}

pub(super) fn classify_cursor_status(
    status: u16,
) -> Result<CursorStatusAction, ProviderTransportError> {
    match status {
        200 => Ok(CursorStatusAction::ReadIdentity),
        401 | 403 => Ok(CursorStatusAction::RejectedAuthentication),
        300..=399 => Err(ProviderTransportError::Redirect),
        status => Err(ProviderTransportError::HttpStatus(status)),
    }
}

#[derive(Deserialize)]
struct CursorAuthBody {
    sub: Option<String>,
}

fn decode_cursor_identity(
    response: reqwest::blocking::Response,
    cancellation: &CancellationToken,
) -> Result<ValidationOutcome, ProviderTransportError> {
    let mut body = Vec::new();
    let read_result = response.take(MAX_IDENTITY_BODY + 1).read_to_end(&mut body);
    if read_result.is_err() {
        body.fill(0);
        return Err(ProviderTransportError::Network);
    }
    if body.len() as u64 > MAX_IDENTITY_BODY {
        body.fill(0);
        return Err(ProviderTransportError::InvalidResponse);
    }
    let outcome = decode_cursor_identity_bytes(&body);
    body.fill(0);
    if cancellation.is_cancelled() {
        return Err(ProviderTransportError::Cancelled);
    }
    outcome
}

pub(super) fn decode_cursor_identity_bytes(
    body: &[u8],
) -> Result<ValidationOutcome, ProviderTransportError> {
    let decoded = serde_json::from_slice::<CursorAuthBody>(body)
        .map_err(|_| ProviderTransportError::InvalidResponse)?;
    match decoded.sub.and_then(VerifiedIdentity::new) {
        Some(identity) => Ok(ValidationOutcome::Verified(identity)),
        None => Ok(ValidationOutcome::MissingIdentity),
    }
}
