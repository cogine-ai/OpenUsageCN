use super::*;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

struct AllRunner {
    active: AtomicUsize,
    maximum_active: AtomicUsize,
    requests: Mutex<Vec<String>>,
}

impl AllRunner {
    fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            maximum_active: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
        }
    }
}

struct ActiveGuard<'a>(&'a AtomicUsize);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl SidecarRunner for AllRunner {
    fn run(
        &self,
        request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        let request: serde_json::Value = serde_json::from_slice(request).expect("request JSON");
        if request["operation"] == "ListProfiles" {
            let profiles = (1..=8)
                .map(|index| {
                    serde_json::json!({
                        "profileKey": format!("Profile {index}"),
                        "displayName": format!("Person {index}")
                    })
                })
                .collect::<Vec<_>>();
            return Ok(ProcessOutput {
                stdout: serde_json::to_vec(&serde_json::json!({
                    "version": 1,
                    "operation": "ListProfiles",
                    "ok": true,
                    "browser": "Chrome",
                    "profiles": profiles
                }))
                .expect("list response"),
            });
        }

        let profile_key = request["profileKey"].as_str().expect("profile key");
        self.requests
            .lock()
            .expect("requests lock")
            .push(profile_key.to_string());
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum_active.fetch_max(active, Ordering::SeqCst);
        let _guard = ActiveGuard(&self.active);
        thread::sleep(Duration::from_millis(20));
        match profile_key {
            "Profile 1" => Ok(cookie_response(profile_key)),
            "Profile 2" => Ok(empty_response(profile_key)),
            "Profile 3" => Err(ProcessRunError::Failed),
            _ => Ok(empty_response(profile_key)),
        }
    }
}

fn empty_response(profile_key: &str) -> ProcessOutput {
    response(profile_key, Vec::new())
}

fn cookie_response(profile_key: &str) -> ProcessOutput {
    response(
        profile_key,
        vec![serde_json::json!({
            "storeId": "/Users/alice/Private/Profile",
            "host": "cursor.com",
            "cookieHeader": "WorkosCursorSessionToken=all-secret"
        })],
    )
}

fn response(profile_key: &str, candidates: Vec<serde_json::Value>) -> ProcessOutput {
    ProcessOutput {
        stdout: serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "operation": "ReadCookies",
            "ok": true,
            "browser": "Chrome",
            "profileKey": profile_key,
            "provider": "Cursor",
            "candidates": candidates,
            "warnings": []
        }))
        .expect("cookie response"),
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
            VerifiedIdentity::new("auth0|all-subject".to_string()).expect("identity"),
        ))
    }
}

struct FixedClock;

impl BrokerClock for FixedClock {
    fn now(&self) -> ClockReading {
        ClockReading {
            monotonic: Duration::from_secs(10),
            unix_ms: 1_800_000_000_000,
        }
    }
}

#[test]
fn all_profiles_is_six_way_bounded_and_returns_stable_per_profile_receipts() {
    let runner = Arc::new(AllRunner::new());
    let broker = BrowserSessionBroker::with_dependencies(
        runner.clone(),
        Arc::new(VerifiedTransport),
        Arc::new(FixedClock),
    );

    let result = broker
        .discover_all(
            Browser::Chrome,
            CookieProvider::Cursor,
            &CancellationToken::new(),
        )
        .expect("all-profile receipt");

    assert_eq!(result.profiles.len(), 8);
    assert_eq!(result.profiles[0].profile_key, "Profile 1");
    assert_eq!(result.profiles[0].status, ProfileDiscoveryStatus::Verified);
    assert_eq!(result.profiles[1].status, ProfileDiscoveryStatus::Empty);
    assert_eq!(result.profiles[2].status, ProfileDiscoveryStatus::Failed);
    assert!(result.partial);
    assert_eq!(runner.maximum_active.load(Ordering::SeqCst), 6);
    assert_eq!(runner.requests.lock().expect("requests lock").len(), 8);
    let serialized = serde_json::to_string(&result).expect("receipt serializes");
    assert!(!serialized.contains("all-secret"));
    assert!(!serialized.contains("all-subject"));
    assert!(!serialized.contains("/Users/alice"));
}

struct CountingRunner(AtomicUsize);

impl SidecarRunner for CountingRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("cancelled discovery must not invoke the helper")
    }
}

#[test]
fn cancellation_before_discovery_persists_nothing_and_starts_no_helper() {
    let runner = Arc::new(CountingRunner(AtomicUsize::new(0)));
    let broker = BrowserSessionBroker::with_dependencies(
        runner.clone(),
        Arc::new(VerifiedTransport),
        Arc::new(FixedClock),
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    let specific = broker.discover_specific(
        Browser::Chrome,
        "Default",
        CookieProvider::Cursor,
        &cancellation,
    );
    assert_eq!(specific.status, ProfileDiscoveryStatus::Failed);
    assert_eq!(
        specific.error.expect("cancelled error").code,
        BrowserSessionErrorCode::Cancelled
    );
    assert_eq!(
        broker
            .discover_all(Browser::Chrome, CookieProvider::Cursor, &cancellation)
            .unwrap_err()
            .code,
        BrowserSessionErrorCode::Cancelled
    );
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
}

struct AdvancingClock {
    seconds: AtomicU64,
}

impl BrokerClock for AdvancingClock {
    fn now(&self) -> ClockReading {
        ClockReading {
            monotonic: Duration::from_secs(self.seconds.load(Ordering::SeqCst)),
            unix_ms: 1_800_000_000_000,
        }
    }
}

struct DeadlineRunner {
    clock: Arc<AdvancingClock>,
}

impl SidecarRunner for DeadlineRunner {
    fn run(
        &self,
        request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        let request: serde_json::Value = serde_json::from_slice(request).expect("request JSON");
        self.clock.seconds.store(61, Ordering::SeqCst);
        assert_eq!(request["operation"], "ListProfiles");
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ListProfiles","ok":true,"browser":"Arc","profiles":[{"profileKey":"Default","displayName":"Personal"}]}"#.to_vec(),
        })
    }
}

#[test]
fn all_profiles_deadline_includes_profile_enumeration() {
    let clock = Arc::new(AdvancingClock {
        seconds: AtomicU64::new(0),
    });
    let broker = BrowserSessionBroker::with_dependencies(
        Arc::new(DeadlineRunner {
            clock: clock.clone(),
        }),
        Arc::new(VerifiedTransport),
        clock,
    );

    assert_eq!(
        broker
            .discover_all(
                Browser::Arc,
                CookieProvider::Cursor,
                &CancellationToken::new(),
            )
            .unwrap_err()
            .code,
        BrowserSessionErrorCode::OverallTimedOut
    );
}
