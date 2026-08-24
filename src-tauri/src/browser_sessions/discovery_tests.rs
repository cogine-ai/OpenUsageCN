use super::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct SpecificRunner;

impl SidecarRunner for SpecificRunner {
    fn run(
        &self,
        request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        let request: serde_json::Value = serde_json::from_slice(request).expect("request JSON");
        assert_eq!(request["profileKey"], "Profile 2");
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Cursor","candidates":[{"storeId":"/Users/alice/Private/Profile 2","host":"cursor.com","cookieHeader":"WorkosCursorSessionToken=super-secret"}],"warnings":[]}"#.to_vec(),
        })
    }
}

#[derive(Default)]
struct RecordingTransport {
    observed: Mutex<Option<(CookieProvider, String, Duration)>>,
}

impl ProviderIdentityTransport for RecordingTransport {
    fn validate(
        &self,
        provider: CookieProvider,
        cookie_header: &str,
        timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        *self.observed.lock().expect("transport lock") =
            Some((provider, cookie_header.to_string(), timeout));
        Ok(ValidationOutcome::Verified(
            VerifiedIdentity::new("auth0|cursor-user".to_string()).expect("identity"),
        ))
    }
}

struct FixedClock;

impl BrokerClock for FixedClock {
    fn now(&self) -> ClockReading {
        ClockReading {
            monotonic: Duration::from_secs(20),
            unix_ms: 1_800_000_000_000,
        }
    }
}

#[test]
fn specific_cursor_profile_is_verified_and_stored_as_a_nonsecret_candidate() {
    let transport = Arc::new(RecordingTransport::default());
    let broker = BrowserSessionBroker::with_dependencies(
        Arc::new(SpecificRunner),
        transport.clone(),
        Arc::new(FixedClock),
    );

    let result = broker.discover_specific(
        Browser::Arc,
        "Profile 2",
        CookieProvider::Cursor,
        &CancellationToken::new(),
    );

    assert_eq!(result.status, ProfileDiscoveryStatus::Verified);
    let candidate = result.candidate.expect("verified candidate");
    assert_eq!(candidate.browser, Browser::Arc);
    assert_eq!(candidate.profile_key, "Profile 2");
    assert_eq!(candidate.host, "cursor.com");
    assert_eq!(candidate.expires_at_ms, 1_800_000_600_000);
    assert!(!candidate.candidate_id.is_empty());
    let serialized = serde_json::to_string(&candidate).expect("candidate serializes");
    assert!(!serialized.contains("super-secret"));
    assert!(!serialized.contains("auth0|cursor-user"));
    assert!(!serialized.contains("/Users/alice"));

    let observed = transport.observed.lock().expect("transport lock");
    let (provider, cookie, timeout) = observed.as_ref().expect("validation request");
    assert_eq!(*provider, CookieProvider::Cursor);
    assert_eq!(cookie, "WorkosCursorSessionToken=super-secret");
    assert_eq!(*timeout, Duration::from_secs(30));
}

struct CancellingTransport;

impl ProviderIdentityTransport for CancellingTransport {
    fn validate(
        &self,
        _provider: CookieProvider,
        _cookie_header: &str,
        _timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        cancellation.cancel();
        Ok(ValidationOutcome::Verified(
            VerifiedIdentity::new("auth0|cancelled-user".to_string()).expect("identity"),
        ))
    }
}

#[test]
fn cancellation_during_provider_validation_does_not_retain_a_candidate() {
    let broker = BrowserSessionBroker::with_dependencies(
        Arc::new(SpecificRunner),
        Arc::new(CancellingTransport),
        Arc::new(FixedClock),
    );
    let cancellation = CancellationToken::new();

    let result = broker.discover_specific(
        Browser::Arc,
        "Profile 2",
        CookieProvider::Cursor,
        &cancellation,
    );

    assert_eq!(result.status, ProfileDiscoveryStatus::Failed);
    assert!(result.candidate.is_none());
    assert_eq!(
        result.error.expect("cancelled error").code,
        BrowserSessionErrorCode::Cancelled
    );
}

struct CancellingRunner {
    cancellation: CancellationToken,
}

impl SidecarRunner for CancellingRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        self.cancellation.cancel();
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Cursor","candidates":[],"warnings":[]}"#.to_vec(),
        })
    }
}

#[test]
fn cancellation_during_cookie_read_wins_over_an_empty_receipt() {
    let cancellation = CancellationToken::new();
    let broker = BrowserSessionBroker::with_dependencies(
        Arc::new(CancellingRunner {
            cancellation: cancellation.clone(),
        }),
        Arc::new(RecordingTransport::default()),
        Arc::new(FixedClock),
    );

    let result = broker.discover_specific(
        Browser::Arc,
        "Profile 2",
        CookieProvider::Cursor,
        &cancellation,
    );

    assert_eq!(result.status, ProfileDiscoveryStatus::Failed);
    assert_eq!(
        result.error.expect("cancelled error").code,
        BrowserSessionErrorCode::Cancelled
    );
}
