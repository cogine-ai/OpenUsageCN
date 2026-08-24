use super::*;

fn parse_manifest(json: &str) -> PluginManifest {
    serde_json::from_str::<PluginManifest>(json).expect("manifest parse failed")
}

#[test]
fn parses_declared_flags_and_defaults_omitted_flags_to_false() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "accountSupport": {
            "localDiscovery": true,
            "modelHistory": true
          },
          "lines": []
        }
        "#,
    );

    let support = manifest
        .account_support
        .expect("declared account support should be available");
    assert!(support.local_discovery);
    assert!(!support.browser_binding);
    assert!(support.model_history);
}

#[test]
fn is_absent_for_legacy_manifests() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "legacy",
          "name": "Legacy",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "lines": []
        }
        "#,
    );

    assert!(manifest.account_support.is_none());
}

#[test]
fn rejects_non_boolean_flags() {
    let error = serde_json::from_str::<PluginManifest>(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "accountSupport": { "localDiscovery": "yes" },
          "lines": []
        }
        "#,
    )
    .expect_err("non-boolean account support flags must be rejected");

    assert!(error.to_string().contains("boolean"));
}
