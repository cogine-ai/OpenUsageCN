use super::claude_profile::{ClaudeOAuthProfileError, ClaudeOAuthProfileTransport};
use super::{ProviderAccountAdapter, QuickJsAccountAdapter};
use crate::browser_sessions::{CancellationToken, VerifiedClaudeOAuthIdentity};
use crate::plugin_engine::manifest::{LoadedPlugin, PluginManifest};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const GENERATION: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

struct RecordingProfileTransport {
    request: Mutex<Option<(String, Duration)>>,
}

impl ClaudeOAuthProfileTransport for RecordingProfileTransport {
    fn fetch_profile(
        &self,
        access_token: &str,
        timeout: Duration,
        _cancellation: &CancellationToken,
    ) -> Result<VerifiedClaudeOAuthIdentity, ClaudeOAuthProfileError> {
        *self.request.lock().unwrap() = Some((access_token.to_string(), timeout));
        VerifiedClaudeOAuthIdentity::new("Member@Example.com".to_string(), "org-123".to_string())
            .ok_or(ClaudeOAuthProfileError::InvalidResponse)
    }
}

fn claude_plugin() -> LoadedPlugin {
    LoadedPlugin {
        manifest: PluginManifest {
            schema_version: 1,
            id: "claude".to_string(),
            name: "Claude".to_string(),
            version: "0.0.0".to_string(),
            entry: "plugin.js".to_string(),
            icon: "icon.svg".to_string(),
            brand_color: None,
            lines: Vec::new(),
            links: Vec::new(),
            status_page: None,
            config: None,
            account_support: None,
        },
        plugin_dir: PathBuf::from("."),
        entry_script: format!(
            r#"
            globalThis.__openusage_plugin = {{
              discoverConnections() {{
                return {{
                  observations: [{{
                    identityNamespace: "claude-oauth-profile-v1",
                    identitySource: "claudeOAuthProfile",
                    connectionKey: "claude-oauth",
                    connectionKind: "cli"
                  }}],
                  sourceOutcomes: [{{ sourceKey: "claude-oauth", status: "available" }}],
                  defaultConnectionKey: "claude-oauth"
                }};
              }},
              credentialGeneration() {{ return "{GENERATION}"; }},
              oauthCredential(ctx, target) {{
                if (target.credentialGeneration !== "{GENERATION}") throw new Error("stale");
                return {{ accessToken: "oauth-secret-canary" }};
              }}
            }};
            "#
        ),
        icon_data_url: String::new(),
    }
}

#[test]
fn claude_discovery_resolves_the_native_profile_to_an_opaque_identity() {
    let transport = Arc::new(RecordingProfileTransport {
        request: Mutex::new(None),
    });
    let adapter =
        QuickJsAccountAdapter::new(claude_plugin(), PathBuf::from("."), "0.0.0".to_string())
            .with_claude_profile_transport(transport.clone());

    let report = adapter.discover_default().expect("discovery succeeds");

    assert_eq!(report.observations.len(), 1);
    let identity = &report.observations[0].normalized_identity;
    assert!(identity.starts_with("claude:"));
    for secret in [
        "Member@Example.com",
        "member@example.com",
        "org-123",
        "oauth-secret-canary",
    ] {
        assert!(!identity.contains(secret));
    }
    let request = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(request.0, "oauth-secret-canary");
    assert_eq!(request.1, Duration::from_secs(30));
}
