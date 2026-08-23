use super::{
    Browser, BrowserSessionBroker, BrowserSessionErrorCode, CookieProvider, ProcessOutput,
    SidecarRunner,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct FakeRunner {
    request: Mutex<Option<Vec<u8>>>,
    timeout: Mutex<Option<Duration>>,
    stdout_limit: Mutex<Option<usize>>,
}

impl SidecarRunner for FakeRunner {
    fn run(
        &self,
        request: &[u8],
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<ProcessOutput, super::ProcessRunError> {
        *self.request.lock().expect("request lock") = Some(request.to_vec());
        *self.timeout.lock().expect("timeout lock") = Some(timeout);
        *self.stdout_limit.lock().expect("limit lock") = Some(stdout_limit);
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Cursor","candidates":[],"warnings":[]}"#.to_vec(),
        })
    }
}

struct ListProfilesRunner {
    request: Mutex<Option<Vec<u8>>>,
    timeout: Mutex<Option<Duration>>,
    stdout_limit: Mutex<Option<usize>>,
}

impl Default for ListProfilesRunner {
    fn default() -> Self {
        Self {
            request: Mutex::new(None),
            timeout: Mutex::new(None),
            stdout_limit: Mutex::new(None),
        }
    }
}

impl SidecarRunner for ListProfilesRunner {
    fn run(
        &self,
        request: &[u8],
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<ProcessOutput, super::ProcessRunError> {
        *self.request.lock().expect("request lock") = Some(request.to_vec());
        *self.timeout.lock().expect("timeout lock") = Some(timeout);
        *self.stdout_limit.lock().expect("limit lock") = Some(stdout_limit);
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ListProfiles","ok":true,"browser":"Chrome","profiles":[{"profileKey":"Default","displayName":"Personal"},{"profileKey":"Profile 2","displayName":"Work"}]}"#.to_vec(),
        })
    }
}

#[test]
fn read_cookies_sends_one_exact_profile_in_a_v1_request() {
    let runner = Arc::new(FakeRunner::default());
    let broker = BrowserSessionBroker::with_runner(runner.clone());

    let response = broker
        .read_cookies(Browser::Arc, "Profile 2", CookieProvider::Cursor)
        .expect("exact profile should be accepted");

    assert!(response.candidates.is_empty());
    let request: serde_json::Value = serde_json::from_slice(
        runner
            .request
            .lock()
            .expect("request lock")
            .as_deref()
            .expect("request must be captured"),
    )
    .expect("request must be JSON");
    assert_eq!(
        request,
        serde_json::json!({
            "version": 1,
            "operation": "ReadCookies",
            "browser": "Arc",
            "profileKey": "Profile 2",
            "provider": "Cursor"
        })
    );
    assert_eq!(
        *runner.timeout.lock().expect("timeout lock"),
        Some(Duration::from_secs(15))
    );
    assert_eq!(
        *runner.stdout_limit.lock().expect("limit lock"),
        Some(2 * 1024 * 1024)
    );
}

#[test]
fn list_profiles_is_a_metadata_only_v1_request_with_a_five_second_deadline() {
    let runner = Arc::new(ListProfilesRunner::default());
    let broker = BrowserSessionBroker::with_runner(runner.clone());

    let response = broker
        .list_profiles(Browser::Chrome)
        .expect("profile metadata should be accepted");

    assert_eq!(response.profiles.len(), 2);
    assert_eq!(response.profiles[0].profile_key, "Default");
    assert_eq!(response.profiles[0].display_name, "Personal");
    let request: serde_json::Value = serde_json::from_slice(
        runner
            .request
            .lock()
            .expect("request lock")
            .as_deref()
            .expect("request must be captured"),
    )
    .expect("request must be JSON");
    assert_eq!(
        request,
        serde_json::json!({
            "version": 1,
            "operation": "ListProfiles",
            "browser": "Chrome"
        })
    );
    assert_eq!(
        *runner.timeout.lock().expect("timeout lock"),
        Some(Duration::from_secs(5))
    );
    assert_eq!(
        *runner.stdout_limit.lock().expect("limit lock"),
        Some(2 * 1024 * 1024)
    );
}

struct RejectingRunner;

impl SidecarRunner for RejectingRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, super::ProcessRunError> {
        panic!("invalid profile input must not start the helper")
    }
}

struct FailureRunner(super::ProcessRunError);

impl SidecarRunner for FailureRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, super::ProcessRunError> {
        Err(match self.0 {
            super::ProcessRunError::TimedOut => super::ProcessRunError::TimedOut,
            super::ProcessRunError::OutputTooLarge => super::ProcessRunError::OutputTooLarge,
            super::ProcessRunError::Failed => super::ProcessRunError::Failed,
        })
    }
}

struct OutputRunner(Vec<u8>);

impl SidecarRunner for OutputRunner {
    fn run(
        &self,
        _request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, super::ProcessRunError> {
        Ok(ProcessOutput {
            stdout: self.0.clone(),
        })
    }
}

#[test]
fn read_cookies_rejects_noncanonical_profiles_before_browser_access() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(RejectingRunner));

    for profile_key in [
        "All Profiles",
        "../Default",
        "/Users/alice/Private/Profile 2",
        "Profile\\2",
        " Bad",
        "Bad\nProfile",
    ] {
        let error = match broker.read_cookies(Browser::Chrome, profile_key, CookieProvider::Claude)
        {
            Ok(_) => panic!("noncanonical profile must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error.code, BrowserSessionErrorCode::InvalidProfileKey);
        let safe_error = serde_json::to_string(&error).expect("error serializes");
        assert!(!safe_error.contains(profile_key));
        assert!(!safe_error.contains("/Users/alice"));
    }
}

#[test]
fn helper_timeout_is_a_typed_nonsecret_error() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(FailureRunner(
        super::ProcessRunError::TimedOut,
    )));

    let error = match broker.list_profiles(Browser::Arc) {
        Ok(_) => panic!("timeout must fail"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::TimedOut);
    let safe_error = serde_json::to_string(&error).expect("error serializes");
    assert!(!safe_error.contains("session=super-secret"));
    assert!(!safe_error.contains("/Users/alice/Private"));
}

#[test]
fn oversized_helper_output_is_rejected_without_exposing_its_contents() {
    let mut stdout = vec![b'x'; 2 * 1024 * 1024 + 1];
    stdout[..20].copy_from_slice(b"session=super-secret");
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(stdout)));

    let error = match broker.list_profiles(Browser::Chrome) {
        Ok(_) => panic!("oversized output must fail"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::OutputTooLarge);
    let safe_error = serde_json::to_string(&error).expect("error serializes");
    assert!(!safe_error.contains("super-secret"));
    assert!(!safe_error.contains("/Users/"));
}

#[test]
fn invalid_json_is_rejected_without_exposing_helper_output() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(
        br#"{"cookie":"session=super-secret","profile":"/Users/alice/Private/Profile 2""#.to_vec(),
    )));

    let error = match broker.read_cookies(Browser::Arc, "Default", CookieProvider::Claude) {
        Ok(_) => panic!("invalid JSON must fail"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::InvalidResponse);
    let safe_error = serde_json::to_string(&error).expect("error serializes");
    assert!(!safe_error.contains("super-secret"));
    assert!(!safe_error.contains("/Users/alice"));
}

#[test]
fn helper_error_uses_an_allowlisted_code_and_ignores_the_returned_message() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(
        br#"{"version":1,"operation":"ReadCookies","ok":false,"error":{"code":"CookieReadFailed","message":"Cookie session=super-secret failed at /Users/alice/Private/Profile 2"}}"#
            .to_vec(),
    )));

    let error = match broker.read_cookies(Browser::Chrome, "Profile 2", CookieProvider::Cursor) {
        Ok(_) => panic!("helper error must fail"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::CookieReadFailed);
    assert_eq!(error.message, "Browser cookies could not be read.");
    let safe_error = serde_json::to_string(&error).expect("error serializes");
    assert!(!safe_error.contains("super-secret"));
    assert!(!safe_error.contains("/Users/alice"));
}

#[test]
fn read_cookies_rejects_candidates_outside_the_provider_allowlist() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(
        br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Chrome","profileKey":"Default","provider":"Cursor","candidates":[{"storeId":"/Users/alice/Private/Profile 2","host":"evil.example","cookieHeader":"session=super-secret"}],"warnings":[]}"#
            .to_vec(),
    )));

    let error = match broker.read_cookies(Browser::Chrome, "Default", CookieProvider::Cursor) {
        Ok(_) => panic!("candidate outside the provider allowlist must fail"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::InvalidResponse);
    let safe_error = serde_json::to_string(&error).expect("error serializes");
    assert!(!safe_error.contains("super-secret"));
    assert!(!safe_error.contains("/Users/alice"));
}

#[test]
fn read_cookies_accepts_allowlisted_candidates_and_sanitizes_warnings() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(
        br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Cursor","candidates":[{"storeId":"runtime-store","host":"cursor.com","cookieHeader":"WorkosCursorSessionToken=first; WorkosCursorSessionToken=second"}],"warnings":[{"code":"CookieReadWarning","message":"Failed at /Users/alice with session=super-secret"}]}"#
            .to_vec(),
    )));

    let response = broker
        .read_cookies(Browser::Arc, "Profile 2", CookieProvider::Cursor)
        .expect("allowlisted candidate should pass");

    assert_eq!(response.candidates.len(), 1);
    assert_eq!(response.candidates[0].host, "cursor.com");
    assert_eq!(response.warnings.len(), 1);
    assert_eq!(
        response.warnings[0].code,
        super::protocol::BrowserSessionWarningCode::CookieReadWarning
    );
    assert_eq!(
        response.warnings[0].message,
        "Some browser cookies could not be read."
    );
}

#[test]
fn list_profiles_rejects_noncanonical_helper_metadata() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(
        br#"{"version":1,"operation":"ListProfiles","ok":true,"browser":"Arc","profiles":[{"profileKey":"../Private","displayName":"/Users/alice/Private"}]}"#
            .to_vec(),
    )));

    let error = match broker.list_profiles(Browser::Arc) {
        Ok(_) => panic!("noncanonical helper metadata must fail"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::InvalidResponse);
    let safe_error = serde_json::to_string(&error).expect("error serializes");
    assert!(!safe_error.contains("/Users/alice"));
}

#[test]
fn list_profiles_rejects_cookie_fields_in_a_metadata_response() {
    let broker = BrowserSessionBroker::with_runner(Arc::new(OutputRunner(
        br#"{"version":1,"operation":"ListProfiles","ok":true,"browser":"Chrome","profiles":[{"profileKey":"Default","displayName":"Personal","cookieHeader":"session=super-secret"}]}"#
            .to_vec(),
    )));

    let error = match broker.list_profiles(Browser::Chrome) {
        Ok(_) => panic!("metadata responses must not contain credentials"),
        Err(error) => error,
    };

    assert_eq!(error.code, BrowserSessionErrorCode::InvalidResponse);
    assert!(
        !serde_json::to_string(&error)
            .expect("error serializes")
            .contains("super-secret")
    );
}
