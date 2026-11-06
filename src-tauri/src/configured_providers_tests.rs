use super::*;
use crate::plugin_engine::manifest;
use serde_json::json;

fn plugins() -> Vec<LoadedPlugin> {
    manifest::load_plugins_from_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"))
}
#[test]
fn fingerprint_environment_names_match_each_bundled_manifest() {
    for plugin in plugins().into_iter().filter(|p| supports(&p.manifest.id)) {
        let declared: std::collections::BTreeSet<_> = plugin
            .manifest
            .config
            .map(|config| config.fields)
            .unwrap_or_default()
            .into_iter()
            .flat_map(|f| f.environment_variables)
            .collect();
        let captured: std::collections::BTreeSet<_> = config_fields(&plugin.manifest.id)
            .unwrap()
            .into_iter()
            .flat_map(|field| field.environment_variables)
            .collect();
        assert_eq!(declared, captured, "{}", plugin.manifest.id);
    }
}

#[test]
fn saved_credentials_do_not_require_an_unused_shell_environment_lookup() {
    let fields = config_fields("litellm").unwrap();
    let saved = HashMap::from([
        ("baseUrl".into(), json!("https://proxy.example")),
        ("apiKey".into(), json!("synthetic-key")),
    ]);
    assert!(required_environment(&fields, &saved).is_empty());
    let fields = config_fields("siliconflow").unwrap();
    let mut saved = HashMap::from([
        ("region".into(), json!("china")),
        ("apiKey".into(), json!("synthetic-key")),
    ]);
    assert!(required_environment(&fields, &saved).is_empty());
    saved.insert("region".into(), json!("auto"));
    assert_eq!(
        required_environment(&fields, &saved),
        ["SILICONFLOW_REGION"]
    );
}

#[test]
fn request_environment_is_frozen_and_undeclared_variables_are_absent() {
    let runtime = rquickjs::Runtime::new().unwrap();
    let context = rquickjs::Context::full(&runtime).unwrap();
    context.with(|vm| {
        vm.eval::<(), _>(
            "globalThis.__openusage_ctx={host:{env:{get:()=> 'unexpected-live-value'}}}",
        )
        .unwrap();
        let mut captured =
            HashMap::from([("LITELLM_API_KEY".into(), Some("synthetic-key-a".into()))]);
        host_api::override_environment(&vm, &captured).unwrap();
        captured.insert("LITELLM_API_KEY".into(), Some("synthetic-key-b".into()));
        assert_eq!(
            vm.eval::<String, _>("__openusage_ctx.host.env.get('LITELLM_API_KEY')")
                .unwrap(),
            "synthetic-key-a"
        );
        assert!(vm
            .eval::<Option<String>, _>("__openusage_ctx.host.env.get('WORKBUDDY_COOKIE')")
            .unwrap()
            .is_none());
    });
}

struct Configuration {
    path: PathBuf,
    original: Option<Vec<u8>>,
}
impl Configuration {
    fn new() -> Self {
        let path = crate::provider_config::config_path().unwrap();
        assert!(path
            .to_string_lossy()
            .contains("openusage-provider-config-tests-"));
        let original = std::fs::read(&path).ok();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        Self { path, original }
    }
    fn write(&self, token: &str) {
        std::fs::write(
            &self.path,
            json!({"version":1,"providers":{"muse":{"accessToken":token}}}).to_string(),
        )
        .unwrap();
    }
}
impl Drop for Configuration {
    fn drop(&mut self) {
        if let Some(original) = &self.original {
            std::fs::write(&self.path, original).unwrap();
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[test]
#[serial_test::serial]
fn final_publication_rejects_changed_credentials_expired_budget_and_preparation_failure() {
    let configuration = Configuration::new();
    configuration.write("dca:synthetic-account-a");
    let plugin = plugins()
        .into_iter()
        .find(|p| p.manifest.id == "muse")
        .unwrap();
    let fields = &plugin.manifest.config.as_ref().unwrap().fields;
    let mut probe = Probe {
        values: crate::provider_config::resolved_values_from_disk("muse", fields).unwrap(),
        fingerprint: crate::provider_config::configuration_fingerprint("muse").unwrap(),
        output: runtime::provider_account_probe_error(&plugin, "Synthetic usage unavailable"),
        plugin,
        started_at: time::OffsetDateTime::now_utc(),
        environment: HashMap::new(),
        preparation_error: None,
        deadline: Instant::now() + Duration::from_secs(30),
    };
    assert!(probe.publish(|_, _| Ok("published account a")).is_ok());
    configuration.write("dca:synthetic-account-b");
    assert!(probe
        .publish::<()>(|_, _| panic!("late account a must not publish"))
        .is_err());
    configuration.write("dca:synthetic-account-a");
    probe.deadline = Instant::now();
    assert!(probe
        .publish::<()>(|_, _| panic!("expired probe must not publish"))
        .is_err());
    probe.deadline = Instant::now() + Duration::from_secs(30);
    probe.preparation_error = Some("Synthetic source error".into());
    assert_eq!(
        probe
            .publish::<()>(|_, _| panic!("failed source must not publish"))
            .unwrap_err(),
        "Synthetic source error"
    );
}
