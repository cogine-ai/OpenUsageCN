use super::*;
use serde_json::json;

fn config_fields(value: serde_json::Value) -> Vec<PluginConfigField> {
    serde_json::from_value(value).unwrap()
}

fn empty_view() -> ProviderConfigView {
    ProviderConfigView {
        values: HashMap::new(),
        environment: HashMap::new(),
        environment_error: None,
        environment_unresolved: vec![],
        stored_fields: vec![],
    }
}

fn env(entries: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
    entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.map(str::to_string)))
        .collect()
}

fn moonshot_fields() -> Vec<PluginConfigField> {
    let manifest: crate::plugin_engine::manifest::PluginManifest =
        serde_json::from_str(include_str!("../../plugins/moonshot/plugin.json")).unwrap();
    manifest.config.unwrap().fields
}

#[test]
fn only_declared_provider_environment_names_are_queried_and_deduplicated() {
    let names = environment_names("moonshot", &moonshot_fields()).unwrap();
    assert_eq!(names, vec!["MOONSHOT_REGION", "MOONSHOT_API_KEY"]);
    let fields = config_fields(json!([{"id":"key","type":"secret","label":"Key",
        "environmentVariables":["OPENROUTER_API_KEY"]}]));
    assert!(environment_names("moonshot", &fields).is_err());
    let fields = config_fields(json!([{"id":"key","type":"secret","label":"Key",
        "environmentVariables":["MOONSHOT_API_KEY;printenv"]}]));
    assert!(environment_names("moonshot", &fields).is_err());
}

#[test]
fn secret_environment_sources_expose_only_presence_and_register_all_values_for_redaction() {
    let fields = config_fields(json!([{"id":"apiKey","type":"secret","label":"API Key",
        "environmentVariables":["ALIBABA_CODING_PLAN_API_KEY","ALIBABA_QWEN_API_KEY"]}]));
    let primary = "configured-primary-secret-5829731";
    let secondary = "configured-secondary-secret-1942856";
    let mut view = empty_view();
    decorate(
        &mut view,
        "alibaba-coding-plan",
        &fields,
        &env(&[
            ("ALIBABA_CODING_PLAN_API_KEY", Some(primary)),
            ("ALIBABA_QWEN_API_KEY", Some(secondary)),
        ]),
    );
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(
        json["environment"]["apiKey"]["name"],
        "ALIBABA_CODING_PLAN_API_KEY"
    );
    assert_eq!(json["environment"]["apiKey"]["configured"], true);
    assert!(json["environment"]["apiKey"].get("value").is_none());
    assert!(!json.to_string().contains(primary));
    assert!(!json.to_string().contains(secondary));
    let redacted = host_api::redact_log_message(&format!("{primary} {secondary}"));
    assert!(!redacted.contains(primary));
    assert!(!redacted.contains(secondary));
}

#[test]
fn blank_sources_are_absent_and_next_nonempty_source_wins() {
    let fields = config_fields(json!([{"id":"apiKey","type":"secret","label":"Key",
        "environmentVariables":["ALIBABA_CODING_PLAN_API_KEY","ALIBABA_QWEN_API_KEY"]}]));
    let mut view = empty_view();
    decorate(
        &mut view,
        "alibaba-coding-plan",
        &fields,
        &env(&[
            ("ALIBABA_CODING_PLAN_API_KEY", Some("")),
            ("ALIBABA_QWEN_API_KEY", None),
        ]),
    );
    assert!(view.environment.is_empty());
    decorate(
        &mut view,
        "alibaba-coding-plan",
        &fields,
        &env(&[
            ("ALIBABA_CODING_PLAN_API_KEY", Some("")),
            ("ALIBABA_QWEN_API_KEY", Some("configured-key-2184539")),
        ]),
    );
    assert_eq!(view.environment["apiKey"].name, "ALIBABA_QWEN_API_KEY");
}

#[test]
fn public_select_values_must_match_declared_options() {
    let fields = moonshot_fields();
    let mut view = empty_view();
    decorate(
        &mut view,
        "moonshot",
        &fields,
        &env(&[("MOONSHOT_REGION", Some("china"))]),
    );
    assert_eq!(view.environment["region"].value.as_deref(), Some("china"));
    let mut invalid = empty_view();
    decorate(
        &mut invalid,
        "moonshot",
        &fields,
        &env(&[("MOONSHOT_REGION", Some("secret-like-invalid-region"))]),
    );
    assert!(invalid.environment["region"].value.is_none());
    assert!(
        !serde_json::to_string(&invalid)
            .unwrap()
            .contains("secret-like-invalid-region")
    );
    let mut auto = empty_view();
    decorate(
        &mut auto,
        "moonshot",
        &fields,
        &env(&[("MOONSHOT_REGION", Some("auto"))]),
    );
    assert!(auto.environment["region"].value.is_none());
}

#[test]
fn even_misdeclared_selects_never_expose_secret_values() {
    let secret = "misdeclared-select-secret-54231987";
    let fields = config_fields(json!([{"id":"key","type":"select","label":"Key",
        "options":[{"value":secret,"label":"Secret"}],"environmentVariables":["MOONSHOT_API_KEY"]}]));
    let mut view = empty_view();
    decorate(
        &mut view,
        "moonshot",
        &fields,
        &env(&[("MOONSHOT_API_KEY", Some(secret))]),
    );
    assert!(view.environment["key"].value.is_none());
    assert!(!serde_json::to_string(&view).unwrap().contains(secret));
}

#[test]
fn moonshot_api_key_presence_belongs_only_to_the_environment_region() {
    let fields = moonshot_fields();
    for (region, expected) in [
        (None, "apiKeyIntl"),
        (Some(""), "apiKeyIntl"),
        (Some("international"), "apiKeyIntl"),
        (Some("china"), "apiKeyCn"),
    ] {
        let mut view = empty_view();
        decorate(
            &mut view,
            "moonshot",
            &fields,
            &env(&[
                ("MOONSHOT_REGION", region),
                ("MOONSHOT_API_KEY", Some("configured-moonshot-key-9814532")),
            ]),
        );
        assert!(view.environment.contains_key(expected));
        let inactive = if expected == "apiKeyCn" {
            "apiKeyIntl"
        } else {
            "apiKeyCn"
        };
        assert!(!view.environment.contains_key(inactive));
    }
    let mut view = empty_view();
    decorate(
        &mut view,
        "moonshot",
        &fields,
        &env(&[
            ("MOONSHOT_REGION", Some("invalid")),
            ("MOONSHOT_API_KEY", Some("configured-moonshot-key-9814532")),
        ]),
    );
    assert!(!view.environment.contains_key("apiKeyCn"));
    assert!(!view.environment.contains_key("apiKeyIntl"));
}

#[test]
fn unresolved_environment_keeps_saved_values_and_known_sources_with_an_observable_error() {
    let fields = config_fields(json!([
        {"id":"apiKey","type":"secret","label":"Key","environmentVariables":["ALIBABA_CODING_PLAN_API_KEY"]},
        {"id":"cookieHeader","type":"secret","label":"Cookie","environmentVariables":["ALIBABA_CODING_PLAN_COOKIE"]}
    ]));
    let mut saved = empty_view();
    saved.values.insert(
        "apiKey".into(),
        crate::provider_config::ProviderConfigViewValue::Secret {
            configured: true,
            hint: Some("...1234".into()),
        },
    );
    saved.stored_fields = vec!["apiKey".into()];
    let resolved = host_api::ResolvedEnvValues {
        values: env(&[(
            "ALIBABA_CODING_PLAN_API_KEY",
            Some("known-env-secret-7468153"),
        )]),
        unresolved: HashSet::from(["ALIBABA_CODING_PLAN_COOKIE".into()]),
    };
    let view = with_environment(saved, "alibaba-coding-plan", &fields, &resolved);
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["values"]["apiKey"]["configured"], true);
    assert_eq!(json["values"]["apiKey"]["hint"], "...1234");
    assert_eq!(json["storedFields"], json!(["apiKey"]));
    assert_eq!(json["environment"]["apiKey"]["configured"], true);
    assert_eq!(
        json["environmentError"],
        "无法确认环境变量配置，请检查终端设置后重试。"
    );
    assert!(!json.to_string().contains("known-env-secret-7468153"));
    assert!(!view.environment.contains_key("cookieHeader"));
    assert_eq!(
        json["environmentUnresolved"],
        json!(["ALIBABA_CODING_PLAN_COOKIE"])
    );
}

#[test]
fn confirmed_absence_has_no_error_but_an_unresolved_region_does_not_choose_a_key() {
    let fields = moonshot_fields();
    let absent = host_api::ResolvedEnvValues {
        values: env(&[("MOONSHOT_REGION", None), ("MOONSHOT_API_KEY", None)]),
        unresolved: HashSet::new(),
    };
    let view = with_environment(empty_view(), "moonshot", &fields, &absent);
    assert!(view.environment_error.is_none());
    assert!(
        serde_json::to_value(view)
            .unwrap()
            .get("environmentError")
            .is_none()
    );
    let unknown_region = host_api::ResolvedEnvValues {
        values: env(&[("MOONSHOT_API_KEY", Some("known-env-secret-7468153"))]),
        unresolved: HashSet::from(["MOONSHOT_REGION".into()]),
    };
    let view = with_environment(empty_view(), "moonshot", &fields, &unknown_region);
    assert!(view.environment_error.is_some());
    assert!(!view.environment.contains_key("apiKeyIntl"));
    assert!(!view.environment.contains_key("apiKeyCn"));
    assert!(!view.environment.contains_key("region"));
    assert_eq!(view.environment_unresolved, vec!["MOONSHOT_REGION"]);
}
