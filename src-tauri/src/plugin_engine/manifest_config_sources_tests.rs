use super::*;
use crate::plugin_engine::manifest::PluginManifest;
use serde_json::{Value, json};

fn fields(value: Value) -> Vec<PluginConfigField> {
    serde_json::from_value(value).unwrap()
}

fn valid_fields() -> Value {
    json!([
        {"id":"region","type":"select","label":"Region","autoValue":"auto",
         "environmentVariables":["MOONSHOT_REGION"],"options":[
             {"value":"auto","label":"Auto"},{"value":"china","label":"China"}]},
        {"id":"key","type":"secret","label":"Key","environmentVariables":["MOONSHOT_API_KEY"],
         "visibleWhen":{"field":"region","values":["china"]}}
    ])
}

#[test]
fn accepts_and_serializes_conditional_sources() {
    let fields = fields(valid_fields());
    validate_config_sources("moonshot", &fields).unwrap();
    let roundtrip = serde_json::to_value(&fields).unwrap();
    assert_eq!(roundtrip[0]["autoValue"], "auto");
    assert_eq!(roundtrip[1]["visibleWhen"]["field"], "region");
    assert_eq!(roundtrip[1]["environmentVariables"][0], "MOONSHOT_API_KEY");
}

#[test]
fn required_defaults_to_false_and_is_supported_only_for_text_or_secret() {
    assert!(fields(valid_fields()).iter().all(|field| !field.required));
    for field_type in ["text", "secret", "select", "toggle"] {
        let mut value = valid_fields();
        value[1]["type"] = json!(field_type);
        value[1]["required"] = json!(true);
        let parsed = fields(value);
        assert_eq!(
            validate_config_sources("moonshot", &parsed).is_ok(),
            matches!(field_type, "text" | "secret")
        );
        assert_eq!(serde_json::to_value(&parsed).unwrap()[1]["required"], true);
    }
}

#[test]
fn required_must_be_a_boolean() {
    let mut value = valid_fields();
    value[1]["required"] = json!("true");
    assert!(serde_json::from_value::<Vec<PluginConfigField>>(value).is_err());
}

#[test]
fn bundled_required_credentials_match_the_selected_connection_contracts() {
    for (raw, expected) in [
        (
            include_str!("../../../plugins/alibaba-coding-plan/plugin.json"),
            vec!["apiKey", "cookieHeader"],
        ),
        (
            include_str!("../../../plugins/alibaba-token-plan/plugin.json"),
            vec!["cookieHeader"],
        ),
        (
            include_str!("../../../plugins/moonshot/plugin.json"),
            vec!["apiKeyIntl", "apiKeyCn"],
        ),
        (include_str!("../../../plugins/gemini/plugin.json"), vec![]),
    ] {
        let manifest: PluginManifest = serde_json::from_str(raw).unwrap();
        let fields = manifest.config.unwrap().fields;
        validate_config_sources(&manifest.id, &fields).unwrap();
        let required: Vec<&str> = fields
            .iter()
            .filter(|field| field.required)
            .map(|field| field.id.as_str())
            .collect();
        assert_eq!(
            required, expected,
            "{} required credentials changed",
            manifest.id
        );
    }
}

#[test]
fn rejects_unknown_self_or_non_select_visibility_dependencies() {
    for dependency in ["missing", "key"] {
        let mut value = valid_fields();
        value[1]["visibleWhen"]["field"] = json!(dependency);
        assert!(validate_config_sources("moonshot", &fields(value)).is_err());
    }
    let mut value = valid_fields();
    value[0]["type"] = json!("text");
    value[0].as_object_mut().unwrap().remove("autoValue");
    assert!(validate_config_sources("moonshot", &fields(value)).is_err());
}

#[test]
fn rejects_missing_duplicate_or_empty_visibility_options() {
    for options in [json!([]), json!(["missing"]), json!(["china", "china"])] {
        let mut value = valid_fields();
        value[1]["visibleWhen"]["values"] = options;
        assert!(validate_config_sources("moonshot", &fields(value)).is_err());
    }
}

#[test]
fn rejects_unknown_or_non_select_auto_values() {
    let mut value = valid_fields();
    value[0]["autoValue"] = json!("missing");
    assert!(validate_config_sources("moonshot", &fields(value)).is_err());
    let mut value = valid_fields();
    value[1]["autoValue"] = json!("auto");
    assert!(validate_config_sources("moonshot", &fields(value)).is_err());
}

#[test]
fn rejects_cross_provider_duplicate_or_injected_environment_names() {
    for names in [
        json!(["OPENROUTER_API_KEY"]),
        json!(["MOONSHOT_API_KEY", "MOONSHOT_API_KEY"]),
        json!(["MOONSHOT_API_KEY;env"]),
    ] {
        let mut value = valid_fields();
        value[1]["environmentVariables"] = names;
        assert!(validate_config_sources("moonshot", &fields(value)).is_err());
    }
}

#[test]
fn rejects_selects_exposing_secret_environment_variables() {
    let mut value = valid_fields();
    value[0]["environmentVariables"] = json!(["MOONSHOT_API_KEY"]);
    assert!(validate_config_sources("moonshot", &fields(value)).is_err());
}

#[test]
fn rejects_visibility_cycles() {
    let mut value = valid_fields();
    value[1]["type"] = json!("select");
    value[1]["options"] = json!([{"value":"auto","label":"Auto"}]);
    value[1]
        .as_object_mut()
        .unwrap()
        .remove("environmentVariables");
    value[0]["visibleWhen"] = json!({"field":"key","values":["auto"]});
    assert!(validate_config_sources("moonshot", &fields(value)).is_err());
}

#[test]
fn bundled_provider_metadata_matches_allowed_sources() {
    for raw in [
        include_str!("../../../plugins/moonshot/plugin.json"),
        include_str!("../../../plugins/alibaba-coding-plan/plugin.json"),
        include_str!("../../../plugins/alibaba-token-plan/plugin.json"),
        include_str!("../../../plugins/bigmodel-cn/plugin.json"),
        include_str!("../../../plugins/deepseek/plugin.json"),
        include_str!("../../../plugins/doubao/plugin.json"),
        include_str!("../../../plugins/gemini/plugin.json"),
        include_str!("../../../plugins/ollama/plugin.json"),
        include_str!("../../../plugins/openai-api/plugin.json"),
        include_str!("../../../plugins/opencode/plugin.json"),
        include_str!("../../../plugins/openrouter/plugin.json"),
        include_str!("../../../plugins/xai/plugin.json"),
        include_str!("../../../plugins/zai/plugin.json"),
    ] {
        let manifest: PluginManifest = serde_json::from_str(raw).unwrap();
        validate_config_sources(&manifest.id, &manifest.config.unwrap().fields).unwrap();
    }
}
