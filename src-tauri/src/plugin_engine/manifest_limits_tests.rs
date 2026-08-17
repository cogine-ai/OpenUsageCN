use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn manifest_with_lines(lines: &str) -> PluginManifest {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "id": "test-plugin",
          "name": "Test",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "lines": {lines}
        }}"#
    ))
    .expect("manifest parse failed")
}

#[test]
fn accepts_stable_limit_resource_metadata() {
    let manifest = manifest_with_lines(
        r#"[
          {
            "type": "progress",
            "label": "Session",
            "scope": "overview",
            "limitResource": { "key": "session5h", "kind": "consumption" }
          },
          {
            "type": "progress",
            "label": "Requests",
            "scope": "detail",
            "limitResource": { "key": "requests", "countUnit": "requests" }
          }
        ]"#,
    );

    validate_manifest_lines(&manifest).expect("valid resources should pass");
    assert_eq!(
        manifest.lines[0].limit_resource.as_ref().unwrap().key,
        "session5h"
    );
}

#[test]
fn rejects_duplicate_invalid_or_non_progress_limit_resources() {
    let duplicate = manifest_with_lines(
        r#"[
          { "type": "progress", "label": "A", "scope": "overview", "limitResource": { "key": "weekly" } },
          { "type": "progress", "label": "B", "scope": "detail", "limitResource": { "key": "weekly" } }
        ]"#,
    );
    assert!(
        validate_manifest_lines(&duplicate)
            .unwrap_err()
            .to_string()
            .contains("duplicate limitResource key")
    );

    let invalid = manifest_with_lines(
        r#"[
          { "type": "progress", "label": "A", "scope": "overview", "limitResource": { "key": "Weekly-Usage" } }
        ]"#,
    );
    assert!(
        validate_manifest_lines(&invalid)
            .unwrap_err()
            .to_string()
            .contains("invalid limitResource key")
    );

    let text = manifest_with_lines(
        r#"[
          { "type": "text", "label": "Spend", "scope": "detail", "limitResource": { "key": "spend" } }
        ]"#,
    );
    assert!(
        validate_manifest_lines(&text)
            .unwrap_err()
            .to_string()
            .contains("type is 'text'")
    );

    let balance = manifest_with_lines(
        r#"[
          { "type": "progress", "label": "Credits", "scope": "overview", "limitResource": { "key": "credits", "kind": "balance" } }
        ]"#,
    );
    assert!(
        validate_manifest_lines(&balance)
            .unwrap_err()
            .to_string()
            .contains("cannot export a balance from a progress value")
    );
}

#[test]
fn bundled_provider_limit_resource_keys_are_stable() {
    let expected: BTreeMap<String, BTreeSet<String>> = [
        ("alibaba-coding-plan", &["monthly", "session", "weekly"][..]),
        ("alibaba-token-plan", &["tokenQuota"][..]),
        ("amp", &["free", "orb", "other"][..]),
        ("antigravity", &["claude", "geminiFlash", "geminiPro"][..]),
        ("bigmodel-cn", &["session", "webSearches", "weekly"][..]),
        (
            "claude",
            &["claudeDesign", "extraUsage", "session", "sonnet", "weekly"][..],
        ),
        (
            "codex",
            &["codeReview", "session", "spark", "sparkWeekly", "weekly"][..],
        ),
        ("copilot", &["chat", "completions", "premiumCredits"][..]),
        (
            "cursor",
            &[
                "apiUsage",
                "autoUsage",
                "credits",
                "onDemand",
                "requests",
                "totalUsage",
            ][..],
        ),
        ("devin", &["daily", "weekly"][..]),
        ("factory", &["premium", "standard"][..]),
        ("gemini", &["flash", "flashLite", "pro"][..]),
        ("grok", &["creditsUsed"][..]),
        ("jetbrains-ai-assistant", &["quota"][..]),
        ("kimi", &["session", "weekly"][..]),
        ("kiro", &["bonusCredits", "credits"][..]),
        ("minimax", &["session"][..]),
        ("openai-api", &["credits"][..]),
        ("opencode-go", &["monthly", "session", "weekly"][..]),
        ("opencode", &["session", "weekly"][..]),
        ("openrouter", &["credits", "keyLimit"][..]),
        ("perplexity", &["apiCredits"][..]),
        (
            "synthetic",
            &[
                "fiveHour",
                "freeToolCalls",
                "mana",
                "search",
                "subscription",
            ][..],
        ),
        ("zai", &["session", "webSearches", "weekly"][..]),
    ]
    .into_iter()
    .map(|(provider, keys)| {
        (
            provider.to_string(),
            keys.iter().map(|key| (*key).to_string()).collect(),
        )
    })
    .collect();

    let plugins_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    let mut actual = BTreeMap::new();
    for entry in std::fs::read_dir(plugins_dir).expect("plugins directory should be readable") {
        let manifest_path = entry
            .expect("plugin entry should be readable")
            .path()
            .join("plugin.json");
        if !manifest_path.is_file() {
            continue;
        }
        let manifest: PluginManifest = serde_json::from_slice(
            &std::fs::read(&manifest_path).expect("plugin manifest should be readable"),
        )
        .expect("plugin manifest should parse");
        if manifest.id == "mock" {
            continue;
        }
        let keys = manifest
            .lines
            .iter()
            .filter_map(|line| {
                line.limit_resource
                    .as_ref()
                    .map(|resource| resource.key.clone())
            })
            .collect();
        actual.insert(manifest.id, keys);
    }

    assert_eq!(actual, expected);
}
