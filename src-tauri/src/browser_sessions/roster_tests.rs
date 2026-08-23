use super::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

struct OneCandidateRunner;

impl SidecarRunner for OneCandidateRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Chrome","profileKey":"Default","provider":"Cursor","candidates":[{"storeId":"/Users/alice/Secret/Profile","host":"cursor.com","cookieHeader":"WorkosCursorSessionToken=secret-cookie"}],"warnings":[]}"#.to_vec(),
        })
    }
}

struct VerifiedTransport;

impl ProviderIdentityTransport for VerifiedTransport {
    fn validate(
        &self,
        _provider: CookieProvider,
        _cookie_header: &str,
        _timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        Ok(ValidationOutcome::Verified(
            VerifiedIdentity::new("auth0|secret-subject".to_string()).expect("identity"),
        ))
    }
}

struct AdjustableClock {
    seconds: AtomicU64,
    unix_ms: u64,
}

impl AdjustableClock {
    fn new() -> Self {
        Self {
            seconds: AtomicU64::new(100),
            unix_ms: 1_800_000_000_000,
        }
    }

    fn advance(&self, duration: Duration) {
        self.seconds.fetch_add(duration.as_secs(), Ordering::SeqCst);
    }
}

impl BrokerClock for AdjustableClock {
    fn now(&self) -> ClockReading {
        let elapsed = self.seconds.load(Ordering::SeqCst) - 100;
        ClockReading {
            monotonic: Duration::from_secs(100 + elapsed),
            unix_ms: self.unix_ms + elapsed * 1_000,
        }
    }
}

fn broker(clock: Arc<AdjustableClock>) -> BrowserSessionBroker {
    BrowserSessionBroker::with_dependencies(
        Arc::new(OneCandidateRunner),
        Arc::new(VerifiedTransport),
        clock,
    )
}

fn discover(broker: &BrowserSessionBroker) -> BrowserCandidateSummary {
    broker
        .discover_specific(
            Browser::Chrome,
            "Default",
            CookieProvider::Cursor,
            &CancellationToken::new(),
        )
        .candidate
        .expect("verified candidate")
}

#[test]
fn attach_moves_the_exact_secret_binding_behind_a_random_session_ref() {
    let clock = Arc::new(AdjustableClock::new());
    let broker = broker(clock);
    let first = discover(&broker);
    let second = discover(&broker);
    assert_ne!(first.candidate_id, second.candidate_id);

    let handle = broker
        .attach_candidate(&first.candidate_id)
        .expect("fresh candidate attaches");
    assert_ne!(handle.session_ref, first.candidate_id);
    assert_eq!(handle.expires_at_ms, 1_800_000_600_000);
    let binding = broker
        .session_binding(&handle.session_ref)
        .expect("session remains bound");
    assert_eq!(binding.provider, CookieProvider::Cursor);
    assert_eq!(binding.browser, Browser::Chrome);
    assert_eq!(binding.profile_key, "Default");
    assert_eq!(binding.host, "cursor.com");

    let serialized = format!(
        "{} {}",
        serde_json::to_string(&handle).expect("handle serializes"),
        serde_json::to_string(&binding).expect("binding serializes")
    );
    for secret in ["secret-cookie", "secret-subject", "/Users/alice", "storeId"] {
        assert!(!serialized.contains(secret));
    }
    assert_eq!(
        broker
            .attach_candidate(&first.candidate_id)
            .unwrap_err()
            .code,
        BrowserSessionErrorCode::CandidateNotFound
    );
}

#[test]
fn backend_claim_exposes_identity_and_cookie_only_through_nonserializable_secret_types() {
    let clock = Arc::new(AdjustableClock::new());
    let broker = broker(clock);
    let candidate = discover(&broker);

    let claim = broker
        .claim_candidate(&candidate.candidate_id)
        .expect("candidate claim succeeds");
    assert_eq!(claim.provider(), CookieProvider::Cursor);
    assert_eq!(claim.browser(), Browser::Chrome);
    assert_eq!(claim.profile_key(), "Default");
    assert_eq!(claim.normalized_identity(), "auth0|secret-subject");
    let credential = broker
        .session_credential(claim.session_ref())
        .expect("session credential remains available");
    assert_eq!(
        credential.cookie_header(),
        "WorkosCursorSessionToken=secret-cookie"
    );
    assert_eq!(credential.normalized_identity(), "auth0|secret-subject");
}

#[test]
fn candidates_and_session_refs_expire_after_ten_minutes() {
    let clock = Arc::new(AdjustableClock::new());
    let broker = broker(clock.clone());
    let expiring_candidate = discover(&broker);
    clock.advance(Duration::from_secs(10 * 60));
    assert_eq!(
        broker
            .attach_candidate(&expiring_candidate.candidate_id)
            .unwrap_err()
            .code,
        BrowserSessionErrorCode::CandidateExpired
    );

    let session_candidate = discover(&broker);
    let handle = broker
        .attach_candidate(&session_candidate.candidate_id)
        .expect("new candidate attaches");
    clock.advance(Duration::from_secs(10 * 60));
    assert_eq!(
        broker
            .session_binding(&handle.session_ref)
            .unwrap_err()
            .code,
        BrowserSessionErrorCode::SessionNotFound
    );
}
