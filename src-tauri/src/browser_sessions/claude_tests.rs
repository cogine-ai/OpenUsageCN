use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const OAUTH_ORG: &str = "22222222-2222-2222-2222-222222222222";
const OTHER_ORG: &str = "11111111-1111-1111-1111-111111111111";

fn oauth_identity() -> VerifiedClaudeOAuthIdentity {
    VerifiedClaudeOAuthIdentity::new("  Person@Example.COM\t".to_string(), OAUTH_ORG.to_string())
        .expect("verified OAuth identity")
}

fn membership(org: &str, seat: Option<&str>) -> ClaudeMembershipEvidence {
    ClaudeMembershipEvidence::new(
        Some(org.to_string()),
        seat.map(std::string::ToString::to_string),
    )
}

fn account(
    email: Option<&str>,
    memberships: Vec<ClaudeMembershipEvidence>,
    rotation: Option<&str>,
) -> ClaudeAccountEvidence {
    ClaudeAccountEvidence::new(
        email.map(std::string::ToString::to_string),
        memberships,
        rotation.map(std::string::ToString::to_string),
    )
}

#[test]
fn resolver_requires_email_and_org_and_selects_the_matching_membership() {
    let evidence = account(
        Some("person@example.com"),
        vec![
            membership(OTHER_ORG, Some("team_tier_1")),
            membership(OAUTH_ORG, Some("  TEAM_STANDARD  ")),
        ],
        None,
    );

    let result = super::claude::resolve_claude_account(&evidence, &oauth_identity());

    assert_eq!(result.plan, ClaudeTeamPlan::TeamStandard);
    assert!(result.exact);
    assert_eq!(result.warning, None);
    assert_eq!(result.plan.label(), "Claude Team Standard");
}

#[test]
fn resolver_maps_only_the_second_approved_exact_seat() {
    let evidence = account(
        Some(" PERSON@example.com "),
        vec![membership(OAUTH_ORG, Some("team_tier_1"))],
        None,
    );

    let result = super::claude::resolve_claude_account(&evidence, &oauth_identity());

    assert_eq!(result.plan, ClaudeTeamPlan::TeamPremium);
    assert!(result.exact);
    assert_eq!(result.plan.label(), "Claude Team Premium");
}

#[test]
fn resolver_never_uses_email_alias_or_wrong_organization_as_a_fallback() {
    for evidence in [
        account(
            Some("Person+alias@example.com"),
            vec![membership(OAUTH_ORG, Some("team_standard"))],
            None,
        ),
        account(
            Some("per.son@example.com"),
            vec![membership(OAUTH_ORG, Some("team_standard"))],
            None,
        ),
        account(
            Some("person@example.com"),
            vec![membership(OTHER_ORG, Some("team_standard"))],
            None,
        ),
    ] {
        let result = super::claude::resolve_claude_account(&evidence, &oauth_identity());
        assert_eq!(result.plan, ClaudeTeamPlan::Team);
        assert!(!result.exact);
        assert_eq!(
            result.warning,
            Some(ClaudeTeamWarningCode::IdentityMismatch)
        );
    }
}

#[test]
fn resolver_preserves_generic_team_for_missing_or_unknown_seat_proof() {
    let missing_email = account(
        None,
        vec![membership(OAUTH_ORG, Some("team_standard"))],
        None,
    );
    let unknown_seat = account(
        Some("person@example.com"),
        vec![membership(OAUTH_ORG, Some("enterprise_unknown"))],
        None,
    );
    let missing_organization = account(
        Some("person@example.com"),
        vec![ClaudeMembershipEvidence::new(
            None,
            Some("team_standard".to_string()),
        )],
        None,
    );

    let missing = super::claude::resolve_claude_account(&missing_email, &oauth_identity());
    let unknown = super::claude::resolve_claude_account(&unknown_seat, &oauth_identity());
    let missing_org =
        super::claude::resolve_claude_account(&missing_organization, &oauth_identity());

    assert_eq!(missing.plan, ClaudeTeamPlan::Team);
    assert_eq!(
        missing.warning,
        Some(ClaudeTeamWarningCode::MissingIdentity)
    );
    assert_eq!(unknown.plan, ClaudeTeamPlan::Team);
    assert_eq!(unknown.warning, Some(ClaudeTeamWarningCode::UnknownSeat));
    assert_eq!(missing_org.plan, ClaudeTeamPlan::Team);
    assert_eq!(
        missing_org.warning,
        Some(ClaudeTeamWarningCode::MissingIdentity)
    );
}

#[test]
fn oauth_organization_is_exact_and_is_never_trimmed() {
    assert!(VerifiedClaudeOAuthIdentity::new(
        "person@example.com".to_string(),
        format!(" {OAUTH_ORG}"),
    )
    .is_none());
}

struct ClaudeRunner {
    calls: AtomicUsize,
}

impl SidecarRunner for ClaudeRunner {
    fn run(
        &self,
        request: &[u8],
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let request: serde_json::Value = serde_json::from_slice(request).expect("request JSON");
        assert_eq!(request["operation"], "ReadCookies");
        assert_eq!(request["browser"], "Arc");
        assert_eq!(request["profileKey"], "Profile 2");
        assert_eq!(request["provider"], "Claude");
        assert_eq!(timeout, Duration::from_secs(15));
        assert_eq!(stdout_limit, 2 * 1024 * 1024);
        Ok(ProcessOutput {
            stdout: br#"{"version":1,"operation":"ReadCookies","ok":true,"browser":"Arc","profileKey":"Profile 2","provider":"Claude","candidates":[{"storeId":"/Users/alice/Private/Profile 2","host":"claude.ai","cookieHeader":"sessionKey=sk-ant-old-secret"}],"warnings":[]}"#.to_vec(),
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
        panic!("Claude enrichment must not use the standalone identity transport")
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

struct ScriptedClaudeTransport {
    results: Mutex<VecDeque<Result<ClaudeAccountEvidence, ClaudeAccountTransportError>>>,
    observed: Mutex<Vec<(String, Duration)>>,
}

impl ScriptedClaudeTransport {
    fn new(results: Vec<Result<ClaudeAccountEvidence, ClaudeAccountTransportError>>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            observed: Mutex::new(Vec::new()),
        }
    }
}

impl ClaudeAccountTransport for ScriptedClaudeTransport {
    fn fetch_account(
        &self,
        cookie_header: &str,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
        assert!(!cancellation.is_cancelled());
        self.observed
            .lock()
            .expect("observed lock")
            .push((cookie_header.to_string(), timeout));
        self.results
            .lock()
            .expect("results lock")
            .pop_front()
            .expect("scripted Claude response")
    }
}

fn broker(
    runner: Arc<dyn SidecarRunner>,
    claude: Arc<dyn ClaudeAccountTransport>,
) -> BrowserSessionBroker {
    BrowserSessionBroker::with_dependencies(
        runner,
        Arc::new(UnusedIdentityTransport),
        Arc::new(FixedClock),
    )
    .with_claude_transport(claude)
}

#[test]
fn discovery_attaches_only_a_double_matched_account_and_rotates_in_memory() {
    let runner = Arc::new(ClaudeRunner {
        calls: AtomicUsize::new(0),
    });
    let transport = Arc::new(ScriptedClaudeTransport::new(vec![
        Ok(account(
            Some("person@example.com"),
            vec![membership(OAUTH_ORG, Some("team_standard"))],
            Some("sessionKey=sk-ant-first-rotation"),
        )),
        Ok(account(
            Some("person@example.com"),
            vec![membership(OAUTH_ORG, Some("team_tier_1"))],
            Some("sessionKey=sk-ant-second-rotation"),
        )),
    ]));
    let broker = broker(runner, transport.clone());
    let identity = oauth_identity();

    let discovery = broker.discover_claude_specific(
        Browser::Arc,
        "Profile 2",
        &identity,
        &CancellationToken::new(),
    );

    assert_eq!(discovery.profile.status, ProfileDiscoveryStatus::Verified);
    assert_eq!(discovery.enrichment.plan, ClaudeTeamPlan::TeamStandard);
    let serialized = serde_json::to_string(&discovery).expect("safe discovery receipt");
    for secret in ["person@example.com", OAUTH_ORG, "sk-ant", "/Users/alice"] {
        assert!(!serialized.contains(secret));
    }

    let candidate = discovery.profile.candidate.expect("verified candidate");
    let session = broker
        .attach_candidate(&candidate.candidate_id)
        .expect("attach candidate");
    let refreshed = broker.refresh_claude_enrichment(
        &session.session_ref,
        &identity,
        &CancellationToken::new(),
    );
    assert_eq!(refreshed.plan, ClaudeTeamPlan::TeamPremium);
    assert_eq!(refreshed.credential_generation(), Some(1));

    let observed = transport.observed.lock().expect("observed lock");
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0].0, "sessionKey=sk-ant-old-secret");
    assert_eq!(observed[1].0, "sessionKey=sk-ant-first-rotation");
    assert!(
        observed
            .iter()
            .all(|(_, timeout)| *timeout == Duration::from_secs(30))
    );
    drop(observed);
    let credential = broker
        .session_credential(&session.session_ref)
        .expect("rotated session credential");
    assert_eq!(
        credential.cookie_header(),
        "sessionKey=sk-ant-second-rotation"
    );
    assert!(
        !credential
            .normalized_identity()
            .contains("person@example.com")
    );
    assert!(!credential.normalized_identity().contains(OAUTH_ORG));
}

#[test]
fn mismatch_never_creates_a_browser_only_claude_candidate() {
    let transport = Arc::new(ScriptedClaudeTransport::new(vec![Ok(account(
        Some("another@example.com"),
        vec![membership(OAUTH_ORG, Some("team_standard"))],
        None,
    ))]));
    let broker = broker(
        Arc::new(ClaudeRunner {
            calls: AtomicUsize::new(0),
        }),
        transport,
    );

    let discovery = broker.discover_claude_specific(
        Browser::Arc,
        "Profile 2",
        &oauth_identity(),
        &CancellationToken::new(),
    );

    assert_eq!(discovery.profile.status, ProfileDiscoveryStatus::Failed);
    assert!(discovery.profile.candidate.is_none());
    assert_eq!(
        discovery.enrichment.warning,
        Some(ClaudeTeamWarningCode::IdentityMismatch)
    );
}

#[test]
fn cancellation_starts_no_browser_or_provider_work() {
    struct PanicRunner;
    impl SidecarRunner for PanicRunner {
        fn run(
            &self,
            _request: &[u8],
            _timeout: Duration,
            _stdout_limit: usize,
        ) -> Result<ProcessOutput, ProcessRunError> {
            panic!("cancelled work must not start")
        }
    }
    let transport = Arc::new(ScriptedClaudeTransport::new(Vec::new()));
    let broker = broker(Arc::new(PanicRunner), transport.clone());
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    let result = broker.discover_claude_specific(
        Browser::Chrome,
        "Default",
        &oauth_identity(),
        &cancellation,
    );

    assert_eq!(result.profile.status, ProfileDiscoveryStatus::Failed);
    assert_eq!(
        result.enrichment.warning,
        Some(ClaudeTeamWarningCode::Cancelled)
    );
    assert!(transport.observed.lock().expect("observed lock").is_empty());
}

#[test]
fn refresh_failure_is_nonfatal_and_keeps_generic_team() {
    let transport = Arc::new(ScriptedClaudeTransport::new(vec![
        Ok(account(
            Some("person@example.com"),
            vec![membership(OAUTH_ORG, Some("team_standard"))],
            None,
        )),
        Err(ClaudeAccountTransportError::Timeout),
    ]));
    let broker = broker(
        Arc::new(ClaudeRunner {
            calls: AtomicUsize::new(0),
        }),
        transport,
    );
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
        .expect("session");

    let enrichment = broker.refresh_claude_enrichment(
        &session.session_ref,
        &identity,
        &CancellationToken::new(),
    );

    assert_eq!(enrichment.plan, ClaudeTeamPlan::Team);
    assert!(!enrichment.exact);
    assert_eq!(
        enrichment.warning,
        Some(ClaudeTeamWarningCode::ProviderUnavailable)
    );
}
