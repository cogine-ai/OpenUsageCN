use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::browser_sessions::{
    BrokerClock, Browser, BrowserSessionBroker, CancellationToken, ClaudeAccountEvidence,
    ClaudeAccountTransport, ClaudeAccountTransportError, ClaudeMembershipEvidence, ClockReading,
    CookieProvider, ProcessOutput, ProcessRunError, ProviderIdentityTransport,
    ProviderTransportError, SidecarRunner, ValidationOutcome, VerifiedClaudeOAuthIdentity,
};
use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const EMAIL: &str = "member@example.com";
const ORG: &str = "22222222-2222-2222-2222-222222222222";
const GENERATION: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn oauth_identity() -> VerifiedClaudeOAuthIdentity {
    VerifiedClaudeOAuthIdentity::new(EMAIL.to_string(), ORG.to_string()).expect("identity")
}

fn evidence(email: &str, seat: &str, rotation: Option<&str>) -> ClaudeAccountEvidence {
    ClaudeAccountEvidence::new(
        Some(email.to_string()),
        vec![ClaudeMembershipEvidence::new(
            Some(ORG.to_string()),
            Some(seat.to_string()),
        )],
        rotation.map(str::to_string),
    )
}

struct ClaudeAdapter {
    generation: Arc<Mutex<String>>,
}

impl ProviderAccountAdapter for ClaudeAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "claude-oauth-profile-v1".to_string(),
                normalized_identity: oauth_identity().opaque_identity(),
                connection_key: "claude-oauth".to_string(),
                connection_kind: ConnectionKind::Cli,
            }],
            source_outcomes: vec![SourceOutcome::new("claude-oauth", SourceStatus::Available)],
            default_connection_key: Some("claude-oauth".to_string()),
        })
    }

    fn credential_generation(&self, _connection_key: &str) -> Result<String, String> {
        Ok(self.generation.lock().unwrap().clone())
    }

    fn probe_connection(
        &self,
        _connection_key: &str,
        credential_generation: &str,
    ) -> Result<PluginOutput, String> {
        if self.generation.lock().unwrap().as_str() != credential_generation {
            return Err("stale OAuth generation".to_string());
        }
        Ok(PluginOutput {
            provider_id: "claude".to_string(),
            display_name: "Claude".to_string(),
            plan: Some("Team".to_string()),
            lines: vec![MetricLine::Text {
                label: "Quota".to_string(),
                value: "Available".to_string(),
                color: None,
                subtitle: None,
            }],
            icon_url: String::new(),
        })
    }

    fn claude_oauth_identity(
        &self,
        _connection_key: &str,
        credential_generation: &str,
        _cancellation: &CancellationToken,
    ) -> Result<VerifiedClaudeOAuthIdentity, String> {
        if self.generation.lock().unwrap().as_str() != credential_generation {
            return Err("stale OAuth generation".to_string());
        }
        Ok(oauth_identity())
    }
}

struct ClaudeRunner;

impl SidecarRunner for ClaudeRunner {
    fn run(
        &self,
        request: &[u8],
        _timeout: Duration,
        _stdout_limit: usize,
    ) -> Result<ProcessOutput, ProcessRunError> {
        let request: serde_json::Value = serde_json::from_slice(request).unwrap();
        let browser = request["browser"].as_str().unwrap();
        let profile = request["profileKey"].as_str().unwrap();
        Ok(ProcessOutput {
            stdout: format!(
                r#"{{"version":1,"operation":"ReadCookies","ok":true,"browser":"{browser}","profileKey":"{profile}","provider":"Claude","candidates":[{{"storeId":"/Users/private/Profile 2","host":"claude.ai","cookieHeader":"sessionKey=sk-ant-original"}}],"warnings":[]}}"#,
            )
            .into_bytes(),
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
        panic!("Claude must use its dedicated transport")
    }
}

struct ScriptedClaudeTransport(Mutex<VecDeque<ClaudeAccountEvidence>>);

impl ClaudeAccountTransport for ScriptedClaudeTransport {
    fn fetch_account(
        &self,
        _cookie_header: &str,
        _timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted response"))
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

fn setup(responses: Vec<ClaudeAccountEvidence>) -> (ProviderAccounts, Arc<Mutex<String>>) {
    let generation = Arc::new(Mutex::new(GENERATION.to_string()));
    let accounts = ProviderAccounts::in_memory([57_u8; 32]);
    accounts.register_adapter(
        "claude",
        Box::new(ClaudeAdapter {
            generation: Arc::clone(&generation),
        }),
    );
    assert_eq!(
        accounts
            .perform("claude", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    let broker = Arc::new(
        BrowserSessionBroker::with_dependencies(
            Arc::new(ClaudeRunner),
            Arc::new(UnusedIdentityTransport),
            Arc::new(FixedClock),
        )
        .with_claude_transport(Arc::new(ScriptedClaudeTransport(Mutex::new(
            responses.into(),
        )))),
    );
    accounts.set_browser_broker(Arc::clone(&broker));
    let discovery = accounts
        .discover_claude_browser_profile(Browser::Chrome, "Profile 2", &CancellationToken::new())
        .expect("discovery succeeds");
    let candidate_id = discovery.profile.candidate.unwrap().candidate_id;
    assert_eq!(
        accounts
            .perform(
                "claude",
                ProviderOperation::AttachBrowserCandidate { candidate_id },
            )
            .status,
        OperationStatus::Succeeded
    );
    (accounts, generation)
}

#[test]
fn successful_quota_probe_applies_only_exact_seat_and_preserves_lines() {
    let (accounts, _) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence(EMAIL, "team_tier_1", None),
    ]);

    let output = accounts.run_active_probe("claude").expect("probe succeeds");

    assert_eq!(output.plan.as_deref(), Some("Claude Team Premium"));
    assert!(
        accounts
            .view("claude")
            .unwrap()
            .enrichment_warning
            .is_none()
    );
    assert_eq!(output.lines.len(), 1);
    match &output.lines[0] {
        MetricLine::Text { label, value, .. } => {
            assert_eq!(label, "Quota");
            assert_eq!(value, "Available");
        }
        _ => panic!("quota line changed"),
    }
}

#[test]
fn exact_seat_success_clears_a_previous_identity_mismatch_warning() {
    let (accounts, _) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence("other@example.com", "team_tier_1", None),
        evidence(EMAIL, "team_tier_1", None),
    ]);

    let mismatched = accounts
        .run_active_probe("claude")
        .expect("generic quota remains available");
    assert_eq!(mismatched.plan.as_deref(), Some("Team"));
    assert_eq!(mismatched.lines.len(), 1);
    assert_eq!(
        accounts
            .view("claude")
            .unwrap()
            .enrichment_warning
            .as_ref()
            .map(|warning| warning.code.as_str()),
        Some("identityMismatch")
    );

    let exact = accounts
        .run_active_probe("claude")
        .expect("exact seat probe succeeds");
    assert_eq!(exact.plan.as_deref(), Some("Claude Team Premium"));
    assert_eq!(exact.lines.len(), 1);
    assert!(
        accounts
            .view("claude")
            .unwrap()
            .enrichment_warning
            .is_none()
    );
}

#[test]
fn mismatched_browser_identity_is_nonfatal_and_keeps_generic_team() {
    let (accounts, _) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence("other@example.com", "team_tier_1", None),
    ]);

    let output = accounts
        .run_active_probe("claude")
        .expect("quota probe succeeds");

    assert_eq!(output.plan.as_deref(), Some("Team"));
    assert_eq!(output.lines.len(), 1);
    let warning = accounts
        .view("claude")
        .unwrap()
        .enrichment_warning
        .expect("identity mismatch is visible");
    assert_eq!(warning.code, "identityMismatch");
    assert!(warning.message.contains("does not match"));
    assert!(!warning.correlation_id.is_empty());
}

#[test]
fn unknown_seat_is_visible_and_keeps_the_successful_generic_team_quota() {
    let (accounts, _) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence(EMAIL, "team_future", None),
    ]);

    let output = accounts
        .run_active_probe("claude")
        .expect("quota probe succeeds");

    assert_eq!(output.plan.as_deref(), Some("Team"));
    assert_eq!(output.lines.len(), 1);
    let warning = accounts
        .view("claude")
        .unwrap()
        .enrichment_warning
        .expect("unknown seat is visible");
    assert_eq!(warning.code, "unknownSeat");
    assert!(warning.message.contains("not recognized"));
}

#[test]
fn missing_browser_profile_is_visible_and_keeps_the_successful_generic_team_quota() {
    let (accounts, _) = setup(vec![evidence(EMAIL, "team_standard", None)]);
    let view = accounts.view("claude").unwrap();
    let account_id = view.active_account_id.unwrap();
    let browser_connection_id = view.accounts[0]
        .connections
        .iter()
        .find(|connection| connection.kind == ConnectionKind::Chrome)
        .unwrap()
        .connection_id
        .clone();
    assert_eq!(
        accounts
            .perform(
                "claude",
                ProviderOperation::DetachConnection {
                    account_id,
                    connection_id: browser_connection_id,
                },
            )
            .status,
        OperationStatus::Succeeded
    );

    let output = accounts
        .run_active_probe("claude")
        .expect("quota probe succeeds");

    assert_eq!(output.plan.as_deref(), Some("Team"));
    assert_eq!(output.lines.len(), 1);
    let warning = accounts
        .view("claude")
        .unwrap()
        .enrichment_warning
        .expect("missing browser proof is visible");
    assert_eq!(warning.code, "browserProfileUnavailable");
    assert!(
        warning
            .message
            .contains("Connect a matching Claude browser profile")
    );
}

#[test]
fn cookie_rotation_rejects_an_older_exact_seat_at_publication() {
    let (accounts, _) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence(EMAIL, "team_standard", None),
        evidence(EMAIL, "team_tier_1", Some("sessionKey=sk-ant-rotated")),
    ]);
    let older = accounts
        .prepare_active_probe("claude")
        .expect("first probe");
    let _newer = accounts
        .prepare_active_probe("claude")
        .expect("second probe");

    let error = accounts
        .publish_active_probe(older, |_, _| {})
        .expect_err("rotated browser proof must reject old exact seat");

    assert_eq!(
        error,
        "Claude browser credentials changed during refresh. Try again."
    );
}

#[test]
fn oauth_generation_change_rejects_exact_seat_at_publication() {
    let (accounts, generation) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence(EMAIL, "team_tier_1", None),
    ]);
    let probe = accounts.prepare_active_probe("claude").expect("probe");
    *generation.lock().unwrap() =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();

    let error = accounts
        .publish_active_probe(probe, |_, _| {})
        .expect_err("changed OAuth credential must reject exact seat");

    assert_eq!(
        error,
        "Account credentials changed during refresh. Try again."
    );
}

#[test]
fn rejected_probe_does_not_publish_its_pending_enrichment_warning() {
    let (accounts, generation) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence("other@example.com", "team_tier_1", None),
    ]);
    let probe = accounts.prepare_active_probe("claude").expect("probe");
    *generation.lock().unwrap() =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();

    accounts
        .publish_active_probe(probe, |_, _| {})
        .expect_err("stale OAuth credentials reject publication");

    assert!(
        accounts
            .view("claude")
            .unwrap()
            .enrichment_warning
            .is_none()
    );
}

#[test]
fn bound_exact_profile_can_reacquire_a_runtime_session_without_a_new_account() {
    let (accounts, _) = setup(vec![
        evidence(EMAIL, "team_standard", None),
        evidence(EMAIL, "team_tier_1", None),
    ]);
    {
        let mut providers = accounts.providers.lock().unwrap();
        let browser = providers
            .get_mut("claude")
            .unwrap()
            .accounts
            .iter_mut()
            .flat_map(|account| account.connections.iter_mut())
            .find(|connection| connection.kind == ConnectionKind::Chrome)
            .unwrap();
        browser.session_ref = None;
        browser.available = false;
    }

    let output = accounts.run_active_probe("claude").expect("probe succeeds");

    assert_eq!(output.plan.as_deref(), Some("Claude Team Premium"));
    let view = accounts.view("claude").unwrap();
    assert_eq!(view.accounts.len(), 1);
    assert_eq!(
        view.accounts[0].connection_kinds,
        vec![ConnectionKind::Cli, ConnectionKind::Chrome]
    );
}
