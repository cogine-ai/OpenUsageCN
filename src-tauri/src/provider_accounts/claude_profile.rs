use crate::browser_sessions::{CancellationToken, VerifiedClaudeOAuthIdentity};
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

pub(crate) const CLAUDE_OAUTH_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub(crate) const CLAUDE_OAUTH_PROFILE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const MAX_CLAUDE_OAUTH_PROFILE_BODY: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClaudeOAuthProfileError {
    Cancelled,
    Timeout,
    Network,
    Redirect,
    Authentication,
    InvalidResponse,
    HttpStatus(u16),
}

pub(crate) trait ClaudeOAuthProfileTransport: Send + Sync {
    fn fetch_profile(
        &self,
        access_token: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<VerifiedClaudeOAuthIdentity, ClaudeOAuthProfileError>;
}

pub(crate) struct FixedClaudeOAuthProfileTransport;

impl ClaudeOAuthProfileTransport for FixedClaudeOAuthProfileTransport {
    fn fetch_profile(
        &self,
        access_token: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<VerifiedClaudeOAuthIdentity, ClaudeOAuthProfileError> {
        if cancellation.is_cancelled() {
            return Err(ClaudeOAuthProfileError::Cancelled);
        }
        let timeout = timeout.min(CLAUDE_OAUTH_PROFILE_TIMEOUT);
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout)
            .timeout(timeout)
            .build()
            .map_err(|_| ClaudeOAuthProfileError::Network)?;
        let mut authorization = String::with_capacity("Bearer ".len() + access_token.len());
        authorization.push_str("Bearer ");
        authorization.push_str(access_token);
        let response = client
            .get(CLAUDE_OAUTH_PROFILE_URL)
            .header(reqwest::header::AUTHORIZATION, authorization.as_str())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("anthropic-beta", "oauth-2025-04-20")
            .header(reqwest::header::USER_AGENT, "claude-code/2.1.69")
            .send();
        zero_string(&mut authorization);
        let mut response = response.map_err(map_request_error)?;
        if cancellation.is_cancelled() {
            return Err(ClaudeOAuthProfileError::Cancelled);
        }
        classify_claude_oauth_profile_status(response.status().as_u16())?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_CLAUDE_OAUTH_PROFILE_BODY as u64)
        {
            return Err(ClaudeOAuthProfileError::InvalidResponse);
        }
        let mut body = Vec::new();
        if response
            .by_ref()
            .take((MAX_CLAUDE_OAUTH_PROFILE_BODY + 1) as u64)
            .read_to_end(&mut body)
            .is_err()
        {
            body.fill(0);
            return Err(ClaudeOAuthProfileError::Network);
        }
        let decoded = decode_claude_oauth_profile_bytes(&body);
        body.fill(0);
        if cancellation.is_cancelled() {
            return Err(ClaudeOAuthProfileError::Cancelled);
        }
        decoded
    }
}

pub(super) fn classify_claude_oauth_profile_status(
    status: u16,
) -> Result<(), ClaudeOAuthProfileError> {
    match status {
        200 => Ok(()),
        401 | 403 => Err(ClaudeOAuthProfileError::Authentication),
        300..=399 => Err(ClaudeOAuthProfileError::Redirect),
        status => Err(ClaudeOAuthProfileError::HttpStatus(status)),
    }
}

pub(super) fn decode_claude_oauth_profile_bytes(
    body: &[u8],
) -> Result<VerifiedClaudeOAuthIdentity, ClaudeOAuthProfileError> {
    if body.len() > MAX_CLAUDE_OAUTH_PROFILE_BODY {
        return Err(ClaudeOAuthProfileError::InvalidResponse);
    }
    let wire = serde_json::from_slice::<ClaudeOAuthProfileWire>(body)
        .map_err(|_| ClaudeOAuthProfileError::InvalidResponse)?;
    let email = wire
        .account
        .and_then(|account| account.email_address)
        .or(wire.email_address);
    let organization_uuid = wire
        .organization
        .and_then(|organization| organization.uuid)
        .or(wire.organization_uuid);
    match (email, organization_uuid) {
        (Some(email), Some(organization_uuid)) => {
            VerifiedClaudeOAuthIdentity::new(email, organization_uuid)
                .ok_or(ClaudeOAuthProfileError::InvalidResponse)
        }
        _ => Err(ClaudeOAuthProfileError::InvalidResponse),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOAuthProfileWire {
    account: Option<ClaudeOAuthAccountWire>,
    organization: Option<ClaudeOAuthOrganizationWire>,
    #[serde(alias = "email_address")]
    email_address: Option<String>,
    #[serde(alias = "organization_uuid")]
    organization_uuid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOAuthAccountWire {
    #[serde(alias = "email_address", alias = "email")]
    email_address: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeOAuthOrganizationWire {
    uuid: Option<String>,
}

fn map_request_error(error: reqwest::Error) -> ClaudeOAuthProfileError {
    if error.is_timeout() {
        ClaudeOAuthProfileError::Timeout
    } else {
        ClaudeOAuthProfileError::Network
    }
}

fn zero_string(value: &mut String) {
    unsafe { value.as_bytes_mut().fill(0) };
    value.clear();
}
