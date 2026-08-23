use super::*;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RAW_PROFILE_PATH: &str = "/Users/alice/Library/Application Support/Arc/User Data/Profile 2";

struct CandidateRunner;

impl SidecarRunner for CandidateRunner {
    fn run(
        &self,
        request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        let request: serde_json::Value = serde_json::from_slice(request).expect("request JSON");
        assert_eq!(request["operation"], "ReadCookies");
        Ok(ProcessOutput {
            stdout: format!(
                r#"{{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Cursor","candidates":[{{"storeId":"{RAW_PROFILE_PATH}","host":"authenticator.cursor.sh","cookieHeader":"WorkosCursorSessionToken=fourth-secret"}},{{"storeId":"{RAW_PROFILE_PATH}","host":"cursor.sh","cookieHeader":"WorkosCursorSessionToken=third-secret"}},{{"storeId":"{RAW_PROFILE_PATH}","host":"www.cursor.com","cookieHeader":"WorkosCursorSessionToken=second-secret"}},{{"storeId":"{RAW_PROFILE_PATH}","host":"cursor.com","cookieHeader":"WorkosCursorSessionToken=first-secret"}}],"warnings":[]}}"#
            )
            .into_bytes(),
        })
    }
}

enum ScriptedOutcome {
    Rejected,
    MissingIdentity,
    Verified(&'static str),
    Error(ProviderTransportError),
}

struct ScriptedTransport {
    outcomes: Mutex<VecDeque<ScriptedOutcome>>,
    calls: Mutex<Vec<(String, Duration)>>,
}

impl ScriptedTransport {
    fn new(outcomes: impl IntoIterator<Item = ScriptedOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl ProviderIdentityTransport for ScriptedTransport {
    fn validate(
        &self,
        provider: CookieProvider,
        cookie_header: &str,
        timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        assert_eq!(provider, CookieProvider::Cursor);
        self.calls
            .lock()
            .expect("calls lock")
            .push((cookie_header.to_string(), timeout));
        match self
            .outcomes
            .lock()
            .expect("outcomes lock")
            .pop_front()
            .expect("scripted outcome")
        {
            ScriptedOutcome::Rejected => Ok(ValidationOutcome::RejectedAuthentication),
            ScriptedOutcome::MissingIdentity => Ok(ValidationOutcome::MissingIdentity),
            ScriptedOutcome::Verified(identity) => Ok(ValidationOutcome::Verified(
                VerifiedIdentity::new(identity.to_string()).expect("valid identity"),
            )),
            ScriptedOutcome::Error(error) => Err(error),
        }
    }
}

struct FixedClock;

impl BrokerClock for FixedClock {
    fn now(&self) -> ClockReading {
        ClockReading {
            monotonic: Duration::from_secs(1),
            unix_ms: 1_800_000_000_000,
        }
    }
}

fn broker(transport: Arc<ScriptedTransport>) -> BrowserSessionBroker {
    BrowserSessionBroker::with_dependencies(
        Arc::new(CandidateRunner),
        transport,
        Arc::new(FixedClock),
    )
}

#[test]
fn cursor_falls_back_in_host_priority_only_for_rejection_or_missing_identity() {
    let transport = Arc::new(ScriptedTransport::new([
        ScriptedOutcome::Rejected,
        ScriptedOutcome::MissingIdentity,
        ScriptedOutcome::Verified("auth0|stable-subject"),
    ]));

    let result = broker(transport.clone()).discover_specific(
        Browser::Arc,
        "Profile 2",
        CookieProvider::Cursor,
        &CancellationToken::new(),
    );

    assert_eq!(result.status, ProfileDiscoveryStatus::Verified);
    assert_eq!(
        result.candidate.expect("candidate").host,
        "cursor.sh",
        "the exact candidate that verified must be retained"
    );
    let calls = transport.calls.lock().expect("calls lock");
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].0, "WorkosCursorSessionToken=first-secret");
    assert_eq!(calls[1].0, "WorkosCursorSessionToken=second-secret");
    assert_eq!(calls[2].0, "WorkosCursorSessionToken=third-secret");
    assert!(
        calls
            .iter()
            .all(|(_, timeout)| *timeout == Duration::from_secs(30))
    );
}

#[test]
fn cursor_stops_the_profile_on_every_nonfallback_transport_failure() {
    let cases = [
        (
            ProviderTransportError::Timeout,
            BrowserSessionErrorCode::TimedOut,
        ),
        (
            ProviderTransportError::Network,
            BrowserSessionErrorCode::ProviderValidationFailed,
        ),
        (
            ProviderTransportError::Redirect,
            BrowserSessionErrorCode::ProviderValidationFailed,
        ),
        (
            ProviderTransportError::InvalidResponse,
            BrowserSessionErrorCode::ProviderValidationFailed,
        ),
        (
            ProviderTransportError::HttpStatus(503),
            BrowserSessionErrorCode::ProviderValidationFailed,
        ),
    ];

    for (transport_error, expected_code) in cases {
        let transport = Arc::new(ScriptedTransport::new([
            ScriptedOutcome::Error(transport_error),
            ScriptedOutcome::Verified("must-not-be-used"),
        ]));
        let result = broker(transport.clone()).discover_specific(
            Browser::Arc,
            "Profile 2",
            CookieProvider::Cursor,
            &CancellationToken::new(),
        );

        assert_eq!(result.status, ProfileDiscoveryStatus::Failed);
        assert_eq!(
            result.error.as_ref().expect("typed error").code,
            expected_code
        );
        assert_eq!(transport.calls.lock().expect("calls lock").len(), 1);
        let serialized = serde_json::to_string(&result).expect("result serializes");
        assert!(!serialized.contains("first-secret"));
        assert!(!serialized.contains(RAW_PROFILE_PATH));
    }
}

#[test]
fn cursor_reports_failure_after_every_isolated_candidate_is_rejected() {
    let transport = Arc::new(ScriptedTransport::new([
        ScriptedOutcome::Rejected,
        ScriptedOutcome::MissingIdentity,
        ScriptedOutcome::Rejected,
        ScriptedOutcome::MissingIdentity,
    ]));

    let result = broker(transport.clone()).discover_specific(
        Browser::Arc,
        "Profile 2",
        CookieProvider::Cursor,
        &CancellationToken::new(),
    );

    assert_eq!(result.status, ProfileDiscoveryStatus::Failed);
    assert_eq!(
        result.error.expect("typed error").code,
        BrowserSessionErrorCode::AuthenticationRejected
    );
    assert_eq!(transport.calls.lock().expect("calls lock").len(), 4);
}
