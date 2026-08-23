use super::CancellationToken;
use super::roster::SecretValue;
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

pub(super) const CLAUDE_ACCOUNT_URL: &str = "https://claude.ai/api/account";
pub(super) const CLAUDE_ORIGIN: &str = "https://claude.ai";
pub(super) const MAX_CLAUDE_ACCOUNT_BODY: usize = 1024 * 1024;
const MAX_SESSION_KEY_LENGTH: usize = 64 * 1024;

pub(crate) struct ClaudeMembershipEvidence {
    pub(super) organization_uuid: Option<SecretValue>,
    pub(super) seat_tier: Option<SecretValue>,
}

impl ClaudeMembershipEvidence {
    pub(crate) fn new(organization_uuid: Option<String>, seat_tier: Option<String>) -> Self {
        Self {
            organization_uuid: organization_uuid.map(SecretValue::new),
            seat_tier: seat_tier.map(SecretValue::new),
        }
    }
}

pub(crate) struct ClaudeAccountEvidence {
    pub(super) email: Option<SecretValue>,
    pub(super) memberships: Vec<ClaudeMembershipEvidence>,
    pub(super) rotated_cookie_header: Option<SecretValue>,
}

impl ClaudeAccountEvidence {
    pub(crate) fn new(
        email: Option<String>,
        memberships: Vec<ClaudeMembershipEvidence>,
        rotated_cookie_header: Option<String>,
    ) -> Self {
        Self {
            email: email.map(SecretValue::new),
            memberships,
            rotated_cookie_header: rotated_cookie_header.map(SecretValue::new),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClaudeAccountTransportError {
    Cancelled,
    Timeout,
    Network,
    Redirect,
    Authentication,
    InvalidResponse,
    HttpStatus(u16),
}

pub(crate) trait ClaudeAccountTransport: Send + Sync {
    fn fetch_account(
        &self,
        cookie_header: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError>;
}

pub(super) struct FixedClaudeAccountTransport;

impl ClaudeAccountTransport for FixedClaudeAccountTransport {
    fn fetch_account(
        &self,
        cookie_header: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
        if cancellation.is_cancelled() {
            return Err(ClaudeAccountTransportError::Cancelled);
        }
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout)
            .timeout(timeout)
            .build()
            .map_err(|_| ClaudeAccountTransportError::Network)?;
        let response = client
            .get(CLAUDE_ACCOUNT_URL)
            .header(reqwest::header::ORIGIN, CLAUDE_ORIGIN)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .map_err(map_request_error)?;
        if cancellation.is_cancelled() {
            return Err(ClaudeAccountTransportError::Cancelled);
        }
        classify_claude_status(response.status().as_u16())?;

        let mut rotated_cookie_header = None;
        for header in response.headers().get_all(reqwest::header::SET_COOKIE) {
            let Ok(header) = header.to_str() else {
                continue;
            };
            update_rotation(&mut rotated_cookie_header, header);
        }

        let mut body = Vec::new();
        let read_result = response
            .take((MAX_CLAUDE_ACCOUNT_BODY + 1) as u64)
            .read_to_end(&mut body);
        if read_result.is_err() {
            body.fill(0);
            zero_optional_string(&mut rotated_cookie_header);
            return Err(ClaudeAccountTransportError::Network);
        }
        let decoded = decode_body(&body, rotated_cookie_header);
        body.fill(0);
        if cancellation.is_cancelled() {
            return Err(ClaudeAccountTransportError::Cancelled);
        }
        decoded
    }
}

#[cfg(test)]
pub(super) fn decode_claude_account_bytes(
    body: &[u8],
    set_cookie_headers: &[&str],
) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
    let mut rotated_cookie_header = None;
    for header in set_cookie_headers {
        update_rotation(&mut rotated_cookie_header, header);
    }
    decode_body(body, rotated_cookie_header)
}

pub(super) fn classify_claude_status(status: u16) -> Result<(), ClaudeAccountTransportError> {
    match status {
        200 => Ok(()),
        401 | 403 => Err(ClaudeAccountTransportError::Authentication),
        300..=399 => Err(ClaudeAccountTransportError::Redirect),
        status => Err(ClaudeAccountTransportError::HttpStatus(status)),
    }
}

fn map_request_error(error: reqwest::Error) -> ClaudeAccountTransportError {
    if error.is_timeout() {
        ClaudeAccountTransportError::Timeout
    } else {
        ClaudeAccountTransportError::Network
    }
}

#[derive(Deserialize)]
struct ClaudeAccountWire {
    email_address: Option<String>,
    #[serde(default)]
    memberships: Vec<ClaudeMembershipWire>,
}

#[derive(Deserialize)]
struct ClaudeMembershipWire {
    seat_tier: Option<String>,
    organization: Option<ClaudeOrganizationWire>,
}

#[derive(Deserialize)]
struct ClaudeOrganizationWire {
    uuid: Option<String>,
}

fn decode_body(
    body: &[u8],
    mut rotated_cookie_header: Option<String>,
) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
    if body.len() > MAX_CLAUDE_ACCOUNT_BODY {
        zero_optional_string(&mut rotated_cookie_header);
        return Err(ClaudeAccountTransportError::InvalidResponse);
    }
    let wire = match serde_json::from_slice::<ClaudeAccountWire>(body) {
        Ok(wire) => wire,
        Err(_) => {
            zero_optional_string(&mut rotated_cookie_header);
            return Err(ClaudeAccountTransportError::InvalidResponse);
        }
    };
    Ok(ClaudeAccountEvidence::new(
        wire.email_address,
        wire.memberships
            .into_iter()
            .map(|membership| {
                ClaudeMembershipEvidence::new(
                    membership.organization.and_then(|org| org.uuid),
                    membership.seat_tier,
                )
            })
            .collect(),
        rotated_cookie_header,
    ))
}

fn update_rotation(current: &mut Option<String>, header: &str) {
    let mut search_from = 0;
    while let Some(relative) = header[search_from..].find("sessionKey=") {
        let start = search_from + relative;
        search_from = start + "sessionKey=".len();
        if !is_cookie_boundary(&header[..start]) {
            continue;
        }
        let rest = &header[search_from..];
        let end = rest.find([';', ',']).unwrap_or(rest.len());
        let value = &rest[..end];
        if !valid_session_key(value) {
            continue;
        }
        let replacement = format!("sessionKey={value}");
        if let Some(mut previous) = current.replace(replacement) {
            unsafe { previous.as_bytes_mut().fill(0) };
        }
    }
}

fn is_cookie_boundary(prefix: &str) -> bool {
    prefix
        .chars()
        .rev()
        .find(|character| !character.is_ascii_whitespace())
        .is_none_or(|character| character == ',')
}

fn valid_session_key(value: &str) -> bool {
    value.starts_with("sk-ant-")
        && value.len() <= MAX_SESSION_KEY_LENGTH
        && !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_ascii_whitespace() || character.is_control())
}

fn zero_optional_string(value: &mut Option<String>) {
    if let Some(value) = value {
        unsafe { value.as_bytes_mut().fill(0) };
        value.clear();
    }
}
