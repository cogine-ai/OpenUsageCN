use super::*;
use crate::plugin_engine::manifest::{LoadedPlugin, PluginManifest};
use std::path::PathBuf;

fn test_plugin(provider_id: &str, entry_script: &str) -> LoadedPlugin {
    LoadedPlugin {
        manifest: PluginManifest {
            schema_version: 1,
            id: provider_id.to_string(),
            name: provider_id.to_string(),
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
        entry_script: entry_script.to_string(),
        icon_data_url: "data:image/svg+xml;base64,".to_string(),
    }
}

#[test]
fn parses_the_nonsecret_account_discovery_contract() {
    let plugin = test_plugin(
        "cursor",
        r#"
        globalThis.__openusage_plugin = {
            discoverConnections() {
                return {
                    observations: [{
                        identityNamespace: "cursor-sub-v1",
                        normalizedIdentity: "auth0|private-subject",
                        connectionKey: "cursor-desktop",
                        connectionKind: "desktop"
                    }],
                    sourceOutcomes: [{ sourceKey: "cursor-desktop", status: "available" }],
                    defaultConnectionKey: "cursor-desktop"
                };
            }
        };
        "#,
    );

    let result =
        discover_connections(&plugin, Path::new("."), "0.0.0").expect("discovery succeeds");

    assert_eq!(result.observations.len(), 1);
    assert_eq!(result.observations[0].identity_namespace, "cursor-sub-v1");
    match &result.observations[0].identity {
        AccountDiscoveryIdentity::Normalized(identity) => {
            assert_eq!(identity, "auth0|private-subject")
        }
        AccountDiscoveryIdentity::ClaudeOAuthProfile => panic!("wrong identity source"),
    }
    assert_eq!(result.source_outcomes[0].status, "available");
    assert_eq!(
        result.default_connection_key.as_deref(),
        Some("cursor-desktop")
    );
}

#[test]
fn parses_only_the_claude_native_profile_identity_source() {
    let plugin = test_plugin(
        "claude",
        r#"
        globalThis.__openusage_plugin = {
            discoverConnections() {
                return {
                    observations: [{
                        identityNamespace: "claude-oauth-profile-v1",
                        identitySource: "claudeOAuthProfile",
                        connectionKey: "claude-oauth",
                        connectionKind: "cli"
                    }],
                    sourceOutcomes: [{ sourceKey: "claude-oauth", status: "available" }],
                    defaultConnectionKey: "claude-oauth"
                };
            }
        };
        "#,
    );

    let result =
        discover_connections(&plugin, Path::new("."), "0.0.0").expect("discovery succeeds");

    assert!(matches!(
        result.observations[0].identity,
        AccountDiscoveryIdentity::ClaudeOAuthProfile
    ));
}

#[test]
fn reads_a_bounded_nonsecret_generation_for_one_connection() {
    let plugin = test_plugin(
        "cursor",
        r#"
        globalThis.__openusage_plugin = {
            credentialGeneration(ctx, target) {
                if (target.connectionKey !== "cursor-cli") throw new Error("wrong target");
                return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            }
        };
        "#,
    );

    let generation = credential_generation(&plugin, Path::new("."), "0.0.0", "cursor-cli")
        .expect("generation succeeds");

    assert_eq!(
        generation,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn extracts_only_the_generation_bound_history_cookie() {
    let plugin = test_plugin(
        "cursor",
        r#"
        globalThis.__openusage_plugin = {
            historyCredential(ctx, target) {
                if (target.connectionKey !== "cursor-cli") throw new Error("wrong target");
                if (target.credentialGeneration !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new Error("wrong generation");
                return { cookieHeader: "WorkosCursorSessionToken=process-only-secret" };
            }
        };
        "#,
    );

    let credential = history_credential(
        &plugin,
        Path::new("."),
        "0.0.0",
        "cursor-cli",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    .expect("history credential succeeds");

    assert_eq!(
        credential.expose(),
        "WorkosCursorSessionToken=process-only-secret"
    );
}

#[test]
fn extracts_only_the_generation_bound_claude_access_token() {
    let plugin = test_plugin(
        "claude",
        r#"
        globalThis.__openusage_plugin = {
            oauthCredential(ctx, target) {
                if (target.connectionKey !== "claude-oauth") throw new Error("wrong target");
                if (target.credentialGeneration !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new Error("wrong generation");
                return { accessToken: "oauth-process-only-secret", ignored: "private" };
            }
        };
        "#,
    );

    let credential = claude_oauth_credential(
        &plugin,
        Path::new("."),
        "0.0.0",
        "claude-oauth",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    .expect("OAuth credential succeeds");

    assert_eq!(credential.expose(), "oauth-process-only-secret");
}
