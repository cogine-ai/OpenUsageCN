use super::*;

fn parse_manifest(json: &str) -> PluginManifest {
    serde_json::from_str::<PluginManifest>(json).expect("manifest parse failed")
}

#[test]
fn primary_order_is_none_by_default() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "A", "scope": "overview" }
          ]
        }
        "#,
    );
    assert_eq!(manifest.lines.len(), 1);
    assert!(manifest.lines[0].primary_order.is_none());
    assert!(manifest.links.is_empty());
    assert!(manifest.status_page.is_none());
}

#[test]
fn primary_order_parsed_correctly() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "A", "scope": "overview", "primaryOrder": 1 },
            { "type": "progress", "label": "B", "scope": "overview", "primaryOrder": 2 },
            { "type": "progress", "label": "C", "scope": "overview" }
          ]
        }
        "#,
    );

    assert_eq!(manifest.lines[0].primary_order, Some(1));
    assert_eq!(manifest.lines[1].primary_order, Some(2));
    assert!(manifest.lines[2].primary_order.is_none());
}

#[test]
fn primary_candidates_sorted_by_order() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "Third", "scope": "overview", "primaryOrder": 3 },
            { "type": "progress", "label": "First", "scope": "overview", "primaryOrder": 1 },
            { "type": "progress", "label": "Second", "scope": "overview", "primaryOrder": 2 },
            { "type": "progress", "label": "None", "scope": "overview" }
          ]
        }
        "#,
    );

    // Extract candidates sorted by primary_order (same logic as lib.rs)
    let mut candidates: Vec<_> = manifest
        .lines
        .iter()
        .filter(|l| l.line_type == "progress" && l.primary_order.is_some())
        .collect();
    candidates.sort_by_key(|l| l.primary_order.unwrap());
    let labels: Vec<_> = candidates.iter().map(|l| l.label.as_str()).collect();

    assert_eq!(labels, vec!["First", "Second", "Third"]);
}

#[test]
fn period_parsed_and_weekly_candidate_resolved() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "Session", "scope": "overview", "primaryOrder": 1 },
            { "type": "progress", "label": "Weekly", "scope": "overview", "period": "weekly" }
          ]
        }
        "#,
    );

    assert!(manifest.lines[0].period.is_none());
    assert_eq!(manifest.lines[1].period.as_deref(), Some("weekly"));

    // Exercise the shipped resolver used by list_plugins.
    assert_eq!(weekly_candidate(&manifest.lines), Some("Weekly"));
}

#[test]
fn weekly_candidate_absent_when_no_period() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "Session", "scope": "overview", "primaryOrder": 1 }
          ]
        }
        "#,
    );

    assert_eq!(weekly_candidate(&manifest.lines), None);
}

#[test]
fn weekly_candidate_first_match_wins() {
    // Precedence is intentionally first-match; lock it in so it can't drift silently.
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "Weekly A", "scope": "overview", "period": "weekly" },
            { "type": "progress", "label": "Weekly B", "scope": "overview", "period": "weekly" }
          ]
        }
        "#,
    );

    assert_eq!(weekly_candidate(&manifest.lines), Some("Weekly A"));
}

#[test]
fn weekly_candidate_ignores_unsupported_period() {
    // A typo'd period (e.g. "week") is not recognized; the provider keeps its primary metric.
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "lines": [
            { "type": "progress", "label": "Weekly", "scope": "overview", "period": "week" }
          ]
        }
        "#,
    );

    assert_eq!(weekly_candidate(&manifest.lines), None);
}

#[test]
fn links_are_parsed_when_present() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "links": [
            { "label": "Status", "url": "https://status.example.com" },
            { "label": "Billing", "url": "https://example.com/billing" }
          ],
          "lines": [
            { "type": "progress", "label": "A", "scope": "overview", "primaryOrder": 1 }
          ]
        }
        "#,
    );

    assert_eq!(manifest.links.len(), 2);
    assert_eq!(manifest.links[0].label, "Status");
    assert_eq!(manifest.links[1].url, "https://example.com/billing");
}

#[test]
fn sanitize_plugin_links_filters_invalid_entries() {
    let links = vec![
        PluginLink {
            label: " Status ".to_string(),
            url: " https://status.example.com ".to_string(),
        },
        PluginLink {
            label: " ".to_string(),
            url: "https://example.com".to_string(),
        },
        PluginLink {
            label: "Docs".to_string(),
            url: "ftp://example.com".to_string(),
        },
    ];

    let sanitized = sanitize_plugin_links("x", links);
    assert_eq!(sanitized.len(), 1);
    assert_eq!(sanitized[0].label, "Status");
    assert_eq!(sanitized[0].url, "https://status.example.com");
}

#[test]
fn status_page_is_parsed_and_normalized() {
    let manifest = parse_manifest(
        r#"
        {
          "schemaVersion": 1,
          "id": "x",
          "name": "X",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "statusPage": {
            "apiUrl": " https://status.example.com/api/v2/status.json ",
            "url": " https://status.example.com/ "
          },
          "lines": []
        }
        "#,
    );

    let normalized = normalize_status_page("x", manifest.status_page)
        .expect("valid status page")
        .expect("status page should remain present");
    assert_eq!(
        normalized,
        PluginStatusPage {
            api_url: "https://status.example.com/api/v2/status.json".to_string(),
            url: "https://status.example.com/".to_string(),
        }
    );
}

#[test]
fn status_page_rejects_non_https_urls() {
    let status_page = PluginStatusPage {
        api_url: "http://status.example.com/api/v2/status.json".to_string(),
        url: "https://status.example.com/".to_string(),
    };

    let error = normalize_status_page("x", Some(status_page))
        .expect_err("HTTP status API must be rejected");
    assert!(error.to_string().contains("absolute HTTPS URL"));
}

fn manifest_with_config(config_json: &str) -> PluginManifest {
    parse_manifest(&format!(
        r#"
        {{
          "schemaVersion": 1,
          "id": "test-plugin",
          "name": "Test",
          "version": "0.0.1",
          "entry": "plugin.js",
          "icon": "icon.svg",
          "brandColor": null,
          "config": {config_json},
          "lines": [
            {{ "type": "progress", "label": "A", "scope": "overview" }}
          ]
        }}
        "#
    ))
}

#[test]
fn validate_plugin_config_accepts_well_formed_fields() {
    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            {
              "id": "apiKey",
              "type": "secret",
              "label": "API Key"
            },
            {
              "id": "region",
              "type": "select",
              "label": "Region",
              "options": [
                { "value": "cn", "label": "CN" },
                { "value": "global", "label": "Global" }
              ]
            }
          ]
        }
        "#,
    );

    validate_plugin_config(&manifest).expect("valid config should pass");
}

#[test]
fn validate_plugin_config_rejects_empty_field_id() {
    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            { "id": "  ", "type": "text", "label": "Name" }
          ]
        }
        "#,
    );

    let error = validate_plugin_config(&manifest).expect_err("empty id should fail");
    assert!(
        error
            .to_string()
            .contains("config field id cannot be empty")
    );
}

#[test]
fn validate_plugin_config_rejects_duplicate_field_ids() {
    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            { "id": "apiKey", "type": "secret", "label": "Primary" },
            { "id": "apiKey", "type": "secret", "label": "Duplicate" }
          ]
        }
        "#,
    );

    let error = validate_plugin_config(&manifest).expect_err("duplicate id should fail");
    assert!(error.to_string().contains("is duplicated"));
}

#[test]
fn validate_plugin_config_rejects_empty_label() {
    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            { "id": "apiKey", "type": "secret", "label": "  " }
          ]
        }
        "#,
    );

    let error = validate_plugin_config(&manifest).expect_err("empty label should fail");
    assert!(error.to_string().contains("label cannot be empty"));
}

#[test]
fn validate_plugin_config_rejects_select_without_options() {
    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            { "id": "region", "type": "select", "label": "Region", "options": [] }
          ]
        }
        "#,
    );

    let error = validate_plugin_config(&manifest).expect_err("empty options should fail");
    assert!(error.to_string().contains("needs options"));
}

#[test]
fn validate_plugin_config_rejects_invalid_select_options() {
    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            {
              "id": "region",
              "type": "select",
              "label": "Region",
              "options": [
                { "value": " ", "label": "Blank" },
                { "value": "cn", "label": "CN" }
              ]
            }
          ]
        }
        "#,
    );
    let empty_value = validate_plugin_config(&manifest).expect_err("empty option value");
    assert!(empty_value.to_string().contains("empty option value"));

    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            {
              "id": "region",
              "type": "select",
              "label": "Region",
              "options": [
                { "value": "cn", "label": " " },
                { "value": "global", "label": "Global" }
              ]
            }
          ]
        }
        "#,
    );
    let empty_label = validate_plugin_config(&manifest).expect_err("empty option label");
    assert!(empty_label.to_string().contains("label cannot be empty"));

    let manifest = manifest_with_config(
        r#"
        {
          "fields": [
            {
              "id": "region",
              "type": "select",
              "label": "Region",
              "options": [
                { "value": "cn", "label": "CN" },
                { "value": "cn", "label": "Duplicate" }
              ]
            }
          ]
        }
        "#,
    );
    let duplicate = validate_plugin_config(&manifest).expect_err("duplicate option");
    assert!(duplicate.to_string().contains("is duplicated"));
}
