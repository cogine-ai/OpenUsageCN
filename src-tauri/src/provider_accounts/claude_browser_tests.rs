use super::{
    ConnectionKind, DiscoveryReport, ObservedConnection, OperationStatus, ProviderAccountAdapter,
    ProviderAccounts, ProviderOperation, SourceOutcome, SourceStatus,
};
use crate::browser_sessions::{
    BrokerClock, Browser, BrowserSessionBroker, CancellationToken, ClaudeAccountEvidence,
    ClaudeAccountTransport, ClaudeAccountTransportError, ClaudeMembershipEvidence, ClockReading,
    CookieProvider, ProcessOutput, ProcessRunError, ProfileDiscoveryStatus,
    ProviderIdentityTransport, ProviderTransportError, SidecarRunner, ValidationOutcome,
    VerifiedClaudeOAuthIdentity,
};
use std::sync::Arc;
use std::time::Duration;

const EMAIL: &str = "member@example.com";
const ORG: &str = "22222222-2222-2222-2222-222222222222";
const GENERATION: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn identity(email: &str) -> VerifiedClaudeOAuthIdentity {
    VerifiedClaudeOAuthIdentity::new(email.to_string(), ORG.to_string()).expect("identity")
}

struct ClaudeAdapter {
    account_email: &'static str,
}

impl ProviderAccountAdapter for ClaudeAdapter {
    fn discover_default(&self) -> Result<DiscoveryReport, String> {
        Ok(DiscoveryReport {
            observations: vec![ObservedConnection {
                identity_namespace: "claude-oauth-profile-v1".to_string(),
                normalized_identity: identity(self.account_email).opaque_identity(),
                connection_key: "claude-oauth".to_string(),
                connection_kind: ConnectionKind::Cli,
            }],
            source_outcomes: vec![SourceOutcome::new("claude-oauth", SourceStatus::Available)],
            default_connection_key: Some("claude-oauth".to_string()),
        })
    }

    fn credential_generation(&self, _connection_key: &str) -> Result<String, String> {
        Ok(GENERATION.to_string())
    }

    fn claude_oauth_identity(
        &self,
        _connection_key: &str,
        credential_generation: &str,
        _cancellation: &CancellationToken,
    ) -> Result<VerifiedClaudeOAuthIdentity, String> {
        assert_eq!(credential_generation, GENERATION);
        Ok(identity(self.account_email))
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
        let profile_key = request["profileKey"].as_str().unwrap();
        Ok(ProcessOutput {
            stdout: format!(
                r#"{{"version":1,"operation":"ReadCookies","ok":true,"browser":"{browser}","profileKey":"{profile_key}","provider":"Claude","candidates":[{{"storeId":"/Users/private/Profile 2","host":"claude.ai","cookieHeader":"sessionKey=sk-ant-browser-secret"}}],"warnings":[]}}"#,
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

struct ExactClaudeTransport;

impl ClaudeAccountTransport for ExactClaudeTransport {
    fn fetch_account(
        &self,
        _cookie_header: &str,
        _timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<ClaudeAccountEvidence, ClaudeAccountTransportError> {
        Ok(ClaudeAccountEvidence::new(
            Some(EMAIL.to_string()),
            vec![ClaudeMembershipEvidence::new(
                Some(ORG.to_string()),
                Some("team_standard".to_string()),
            )],
            None,
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

fn broker() -> Arc<BrowserSessionBroker> {
    Arc::new(
        BrowserSessionBroker::with_dependencies(
            Arc::new(ClaudeRunner),
            Arc::new(UnusedIdentityTransport),
            Arc::new(FixedClock),
        )
        .with_claude_transport(Arc::new(ExactClaudeTransport)),
    )
}

fn initialized_accounts(account_email: &'static str) -> ProviderAccounts {
    let accounts = ProviderAccounts::in_memory([51_u8; 32]);
    accounts.register_adapter("claude", Box::new(ClaudeAdapter { account_email }));
    assert_eq!(
        accounts
            .perform("claude", ProviderOperation::RefreshActive)
            .status,
        OperationStatus::Succeeded
    );
    accounts
}

#[test]
fn exact_profile_discovery_and_attachment_only_enrich_the_existing_oauth_account() {
    let accounts = initialized_accounts(EMAIL);
    let broker = broker();
    accounts.set_browser_broker(Arc::clone(&broker));
    let before = accounts.view("claude").unwrap();

    let discovery = accounts
        .discover_claude_browser_profile(Browser::Chrome, "Profile 2", &CancellationToken::new())
        .expect("discovery succeeds");
    assert_eq!(discovery.profile.status, ProfileDiscoveryStatus::Verified);
    let candidate_id = discovery.profile.candidate.unwrap().candidate_id;
    let attached = accounts.perform(
        "claude",
        ProviderOperation::AttachBrowserCandidate { candidate_id },
    );

    assert_eq!(attached.status, OperationStatus::Succeeded);
    assert_eq!(attached.view.accounts.len(), 1);
    assert_eq!(attached.view.active_account_id, before.active_account_id);
    assert_eq!(attached.view.selection, before.selection);
    assert_eq!(
        attached.view.accounts[0].connection_kinds,
        vec![ConnectionKind::Cli, ConnectionKind::Chrome]
    );
}

#[test]
fn claude_candidate_never_creates_an_account_when_the_oauth_owner_differs() {
    let accounts = initialized_accounts("other@example.com");
    let broker = broker();
    accounts.set_browser_broker(Arc::clone(&broker));
    let candidate = broker
        .discover_claude_specific(
            Browser::Chrome,
            "Profile 2",
            &identity(EMAIL),
            &CancellationToken::new(),
        )
        .profile
        .candidate
        .unwrap();

    let attached = accounts.perform(
        "claude",
        ProviderOperation::AttachBrowserCandidate {
            candidate_id: candidate.candidate_id,
        },
    );

    assert_eq!(attached.status, OperationStatus::Failed);
    assert_eq!(attached.view.accounts.len(), 1);
    assert_eq!(
        attached.view.accounts[0].connection_kinds,
        vec![ConnectionKind::Cli]
    );
}
