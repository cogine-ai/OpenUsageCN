use std::io::Read;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{CredentialCandidate, RawNumber, ScriptedEvent, ScriptedPage, ScriptedTokenUsage};

pub(super) const AUTH_ENDPOINT: &str = "https://cursor.com/api/auth/me";
pub(super) const HISTORY_ENDPOINT: &str =
    "https://cursor.com/api/dashboard/get-filtered-usage-events";
pub(super) const CURSOR_ORIGIN: &str = "https://cursor.com";
const MAX_AUTH_BODY: usize = 1024 * 1024;
const MAX_HISTORY_BODY: usize = 16 * 1024 * 1024;

pub(crate) struct AuthIdentity {
    subject: String,
}

impl AuthIdentity {
    pub(crate) fn new(subject: String) -> Self {
        Self { subject }
    }

    pub(super) fn subject(&self) -> &str {
        &self.subject
    }
}

impl Drop for AuthIdentity {
    fn drop(&mut self) {
        unsafe { self.subject.as_bytes_mut().fill(0) };
    }
}

pub(crate) enum AuthOutcome {
    Authenticated(AuthIdentity),
    CandidateRejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportError {
    Network,
    Redirect,
    InvalidResponse,
    HttpStatus(u16),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct PageRequest {
    pub page: u16,
    pub page_size: usize,
    pub start_date_ms: String,
    pub end_date_ms: String,
}

pub(crate) trait HistoryTransport: Send + Sync {
    fn authenticate(
        &self,
        candidate: &CredentialCandidate,
        correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError>;

    fn fetch_page(
        &self,
        candidate: &CredentialCandidate,
        request: &PageRequest,
        correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError>;
}

pub(crate) struct FixedCursorTransport {
    client: reqwest::blocking::Client,
}

impl FixedCursorTransport {
    pub(crate) fn new() -> Result<Self, TransportError> {
        let client = crate::config::blocking_client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| TransportError::Network)?;
        Ok(Self { client })
    }
}

pub(super) fn decode_auth_body(body: &[u8]) -> Result<AuthOutcome, TransportError> {
    let response: Value =
        serde_json::from_slice(body).map_err(|_| TransportError::InvalidResponse)?;
    let object = response
        .as_object()
        .ok_or(TransportError::InvalidResponse)?;
    match object.get("sub") {
        None | Some(Value::Null) => Ok(AuthOutcome::CandidateRejected),
        Some(Value::String(subject)) if subject.trim().is_empty() => {
            Ok(AuthOutcome::CandidateRejected)
        }
        Some(Value::String(subject)) => Ok(AuthOutcome::Authenticated(AuthIdentity::new(
            subject.trim().to_string(),
        ))),
        Some(_) => Err(TransportError::InvalidResponse),
    }
}

pub(super) fn encode_page_body(_request: &PageRequest) -> Result<Vec<u8>, TransportError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WireRequest<'a> {
        page: u16,
        page_size: usize,
        start_date: &'a str,
        end_date: &'a str,
    }

    serde_json::to_vec(&WireRequest {
        page: _request.page,
        page_size: _request.page_size,
        start_date: &_request.start_date_ms,
        end_date: &_request.end_date_ms,
    })
    .map_err(|_| TransportError::InvalidResponse)
}

pub(super) fn decode_page_body(page: u16, body: &[u8]) -> Result<ScriptedPage, TransportError> {
    let response: WirePage =
        serde_json::from_slice(body).map_err(|_| TransportError::InvalidResponse)?;
    let total_usage_events_count = response
        .total_usage_events_count
        .map(parse_total_count)
        .transpose()?;
    Ok(ScriptedPage {
        page,
        events: response
            .usage_events_display
            .into_iter()
            .map(WireEvent::into_scripted)
            .collect::<Result<Vec<_>, _>>()?,
        total_usage_events_count,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePage {
    usage_events_display: Vec<WireEvent>,
    total_usage_events_count: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEvent {
    timestamp: Option<Value>,
    model: Option<String>,
    token_usage: Option<WireTokenUsage>,
    charged_cents: Option<Value>,
    owning_user: Option<Value>,
    owning_team: Option<Value>,
}

impl WireEvent {
    fn into_scripted(self) -> Result<ScriptedEvent, TransportError> {
        Ok(ScriptedEvent {
            timestamp_ms: wire_number(self.timestamp),
            model_name: self.model.unwrap_or_default(),
            token_usage: self.token_usage.map(WireTokenUsage::into_scripted),
            charged_cents: wire_number(self.charged_cents),
            owning_user: ownership_key(self.owning_user)?,
            owning_team: ownership_key(self.owning_team)?,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireTokenUsage {
    input_tokens: Option<Value>,
    output_tokens: Option<Value>,
    cache_write_tokens: Option<Value>,
    cache_read_tokens: Option<Value>,
    total_cents: Option<Value>,
}

impl WireTokenUsage {
    fn into_scripted(self) -> ScriptedTokenUsage {
        ScriptedTokenUsage {
            input_tokens: wire_number(self.input_tokens),
            output_tokens: wire_number(self.output_tokens),
            cache_write_tokens: wire_number(self.cache_write_tokens),
            cache_read_tokens: wire_number(self.cache_read_tokens),
            total_cents: wire_number(self.total_cents),
        }
    }
}

fn parse_total_count(value: Value) -> Result<u64, TransportError> {
    match value {
        Value::Number(value) => value.as_u64().ok_or(TransportError::InvalidResponse),
        Value::String(value) => value
            .trim()
            .parse::<u64>()
            .map_err(|_| TransportError::InvalidResponse),
        _ => Err(TransportError::InvalidResponse),
    }
}

fn wire_number(value: Option<Value>) -> RawNumber {
    let Some(value) = value else {
        return RawNumber::Missing;
    };
    match value {
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                RawNumber::Integer(i128::from(value))
            } else if let Some(value) = value.as_u64() {
                RawNumber::Integer(i128::from(value))
            } else {
                value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .map(RawNumber::Decimal)
                    .unwrap_or(RawNumber::Invalid)
            }
        }
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                return RawNumber::Missing;
            }
            if let Ok(value) = value.parse::<i128>() {
                RawNumber::Integer(value)
            } else {
                value
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite())
                    .map(RawNumber::Decimal)
                    .unwrap_or(RawNumber::Invalid)
            }
        }
        Value::Null => RawNumber::Missing,
        Value::Bool(_) | Value::Array(_) | Value::Object(_) => RawNumber::Invalid,
    }
}

fn ownership_key(value: Option<Value>) -> Result<Option<String>, TransportError> {
    value
        .map(|value| match value {
            Value::String(value) => Ok(value),
            other => serde_json::to_string(&other).map_err(|_| TransportError::InvalidResponse),
        })
        .transpose()
}

impl HistoryTransport for FixedCursorTransport {
    fn authenticate(
        &self,
        candidate: &CredentialCandidate,
        correlation_id: &str,
    ) -> Result<AuthOutcome, TransportError> {
        let started = Instant::now();
        let response = self
            .client
            .get(AUTH_ENDPOINT)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::COOKIE, candidate.cookie())
            .send()
            .map_err(|_| TransportError::Network)?;
        let status = response.status().as_u16();
        log_transport("auth", status, None, None, started, correlation_id);
        if status == 401 || status == 403 {
            return Ok(AuthOutcome::CandidateRejected);
        }
        if (300..400).contains(&status) {
            return Err(TransportError::Redirect);
        }
        if !response.status().is_success() {
            return Err(TransportError::HttpStatus(status));
        }
        let mut body = read_bounded(response, MAX_AUTH_BODY)?;
        let result = decode_auth_body(&body);
        body.fill(0);
        result
    }

    fn fetch_page(
        &self,
        candidate: &CredentialCandidate,
        request: &PageRequest,
        correlation_id: &str,
    ) -> Result<ScriptedPage, TransportError> {
        if request.page == 0 || request.page > 200 || request.page_size != 1_000 {
            return Err(TransportError::InvalidResponse);
        }
        let body = encode_page_body(request)?;
        let started = Instant::now();
        let response = self
            .client
            .post(HISTORY_ENDPOINT)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ORIGIN, CURSOR_ORIGIN)
            .header(reqwest::header::COOKIE, candidate.cookie())
            .body(body)
            .send()
            .map_err(|_| TransportError::Network)?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            log_transport(
                "history",
                status,
                Some(request.page),
                None,
                started,
                correlation_id,
            );
            return Err(TransportError::Redirect);
        }
        if !response.status().is_success() {
            log_transport(
                "history",
                status,
                Some(request.page),
                None,
                started,
                correlation_id,
            );
            return Err(TransportError::HttpStatus(status));
        }
        let mut body = read_bounded(response, MAX_HISTORY_BODY)?;
        let page = decode_page_body(request.page, &body);
        body.fill(0);
        let page = page?;
        log_transport(
            "history",
            status,
            Some(request.page),
            Some(page.events.len()),
            started,
            correlation_id,
        );
        Ok(page)
    }
}

pub(super) fn read_bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, TransportError> {
    let mut body = Vec::with_capacity(limit.min(64 * 1024));
    let mut bounded = reader.by_ref().take(limit.saturating_add(1) as u64);
    if bounded.read_to_end(&mut body).is_err() {
        body.fill(0);
        return Err(TransportError::Network);
    }
    if body.len() > limit {
        body.fill(0);
        return Err(TransportError::InvalidResponse);
    }
    Ok(body)
}

fn log_transport(
    endpoint_class: &str,
    status: u16,
    page: Option<u16>,
    row_count: Option<usize>,
    started: Instant,
    correlation_id: &str,
) {
    log::debug!(
        "Cursor history transport endpointClass={} status={} page={} rowCount={} durationMs={} correlationId={}",
        endpoint_class,
        status,
        page.map_or_else(|| "none".to_string(), |value| value.to_string()),
        row_count.map_or_else(|| "none".to_string(), |value| value.to_string()),
        started.elapsed().as_millis(),
        correlation_id,
    );
}
