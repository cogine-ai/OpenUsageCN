use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const OAUTH_ORG: &str = "22222222-2222-2222-2222-222222222222";

fn oauth_identity() -> VerifiedClaudeOAuthIdentity {
    VerifiedClaudeOAuthIdentity::new("person@example.com".to_string(), OAUTH_ORG.to_string())
        .expect("OAuth identity")
}

fn account(seat: &str, rotation: Option<&str>) -> ClaudeAccountEvidence {
    ClaudeAccountEvidence::new(
        Some("person@example.com".to_string()),
        vec![ClaudeMembershipEvidence::new(
            Some(OAUTH_ORG.to_string()),
            Some(seat.to_string()),
        )],
        rotation.map(std::string::ToString::to_string),
    )
}

struct OneCookieRunner;

impl SidecarRunner for OneCookieRunner {
    fn run(
        &self,
        request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        let request: serde_json::Value = serde_json::from_slice(request).expect("request JSON");
        assert_eq!(request["provider"], "Claude");
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Claude","candidates":[{"storeId":"/private/profile","host":"claude.ai","cookieHeader":"sessionKey=sk-ant-original"}],"warnings":[]}"#.to_vec(),
        })
    }
}

struct UnusedIdentityTransport;

impl ProviderIdentityTransport for UnusedIdentityTransport {
    fn validate(
        &self,
        _provider: CookieProvider,
        _cookie_header: &str,
        _timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ValidationOutcome, ProviderTransportError> {
        panic!("Claude enrichment must not use Cursor validation")
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

struct RacingTransport {
    calls: AtomicUsize,
    broker: Mutex<Option<Weak<BrowserSessionBroker>>>,
    session_ref: Mutex<Option<String>>,
}

impl RacingTransport {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            broker: Mutex::new(None),
            session_ref: Mutex::new(None),
        }
    }
}

impl ClaudeAccountTransport for RacingTransport {
    fn fetch_account(
        &self,
        cookie_header: &str,
        timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
        assert_eq!(timeout, Duration::from_secs(30));
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => {
                assert_eq!(cookie_header, "sessionKey=sk-ant-original");
                Ok(account("team_standard", None))
            }
            1 => {
                assert_eq!(cookie_header, "sessionKey=sk-ant-original");
                let broker = self
                    .broker
                    .lock()
                    .expect("broker lock")
                    .as_ref()
                    .and_then(Weak::upgrade)
                    .expect("live broker");
                let session_ref = self
                    .session_ref
                    .lock()
                    .expect("session lock")
                    .clone()
                    .expect("session ref");
                let committed = broker
                    .roster
                    .lock()
                    .expect("roster lock")
                    .commit_cookie_refresh(
                        broker.clock.now(),
                        &session_ref,
                        CookieProvider::Claude,
                        0,
                        "sessionKey=sk-ant-original",
                        Some("sessionKey=sk-ant-concurrent"),
                    )
                    .expect("concurrent rotation");
                assert_eq!(committed, Some(1));
                Ok(account(
                    "team_tier_1",
                    Some("sessionKey=sk-ant-stale-response"),
                ))
            }
            _ => panic!("unexpected Claude account call"),
        }
    }
}

#[test]
fn stale_enrichment_cannot_publish_or_overwrite_a_rotated_session() {
    let transport = Arc::new(RacingTransport::new());
    let broker = Arc::new(
        BrowserSessionBroker::with_dependencies(
            Arc::new(OneCookieRunner),
            Arc::new(UnusedIdentityTransport),
            Arc::new(FixedClock),
        )
        .with_claude_transport(transport.clone()),
    );
    *transport.broker.lock().expect("broker lock") = Some(Arc::downgrade(&broker));
    let identity = oauth_identity();
    let discovery = broker.discover_claude_specific(
        Browser::Arc,
        "Profile 2",
        &identity,
        &CancellationToken::new(),
    );
    let session = broker
        .attach_candidate(
            &discovery
                .profile
                .candidate
                .expect("verified candidate")
                .candidate_id,
        )
        .expect("attached session");
    *transport.session_ref.lock().expect("session lock") = Some(session.session_ref.clone());

    let enrichment = broker.refresh_claude_enrichment(
        &session.session_ref,
        &identity,
        &CancellationToken::new(),
    );

    assert_eq!(enrichment.plan, ClaudeTeamPlan::Team);
    assert!(!enrichment.exact);
    assert_eq!(
        enrichment.warning,
        Some(ClaudeTeamWarningCode::CredentialsChanged)
    );
    let credential = broker
        .session_credential(&session.session_ref)
        .expect("current credential");
    assert_eq!(credential.cookie_header(), "sessionKey=sk-ant-concurrent");
    let serialized = serde_json::to_string(&enrichment).expect("safe warning");
    assert!(!serialized.contains("sk-ant"));
    assert!(!serialized.contains("person@example.com"));
    assert!(!serialized.contains(OAUTH_ORG));
}

#[test]
fn an_unbound_or_different_oauth_identity_starts_no_account_request() {
    let transport = Arc::new(RacingTransport::new());
    let broker = BrowserSessionBroker::with_dependencies(
        Arc::new(OneCookieRunner),
        Arc::new(UnusedIdentityTransport),
        Arc::new(FixedClock),
    )
    .with_claude_transport(transport.clone());

    let missing = broker.refresh_claude_enrichment(
        "missing-session",
        &oauth_identity(),
        &CancellationToken::new(),
    );

    assert_eq!(missing.plan, ClaudeTeamPlan::Team);
    assert_eq!(
        missing.warning,
        Some(ClaudeTeamWarningCode::SessionUnavailable)
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);

    let identity = oauth_identity();
    let discovery = broker.discover_claude_specific(
        Browser::Arc,
        "Profile 2",
        &identity,
        &CancellationToken::new(),
    );
    let session = broker
        .attach_candidate(
            &discovery
                .profile
                .candidate
                .expect("verified candidate")
                .candidate_id,
        )
        .expect("attached session");
    let other_identity =
        VerifiedClaudeOAuthIdentity::new("other@example.com".to_string(), OAUTH_ORG.to_string())
            .expect("other OAuth identity");

    let mismatch = broker.refresh_claude_enrichment(
        &session.session_ref,
        &other_identity,
        &CancellationToken::new(),
    );

    assert_eq!(mismatch.plan, ClaudeTeamPlan::Team);
    assert_eq!(
        mismatch.warning,
        Some(ClaudeTeamWarningCode::IdentityMismatch)
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}
