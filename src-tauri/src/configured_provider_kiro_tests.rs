use super::*;
use crate::local_http_api::cache;

struct Credentials {
    token: PathBuf,
    original: Option<Vec<u8>>,
}
impl Credentials {
    fn new() -> Self {
        let home = crate::kiro_sources::test_home();
        assert!(home
            .to_string_lossy()
            .contains("openusage-kiro-source-test-"));
        let token = home.join(".aws/sso/cache/kiro-auth-token.json");
        let original = std::fs::read(&token).ok();
        std::fs::create_dir_all(token.parent().unwrap()).unwrap();
        Self { token, original }
    }
    fn write(&self, account: &str) {
        std::fs::write(
            &self.token,
            format!(r#"{{"accessToken":"synthetic-{account}"}}"#),
        )
        .unwrap();
    }
}
impl Drop for Credentials {
    fn drop(&mut self) {
        if let Some(bytes) = &self.original {
            std::fs::write(&self.token, bytes).unwrap();
        } else {
            let _ = std::fs::remove_file(&self.token);
        }
    }
}
fn output(used: f64) -> PluginOutput {
    PluginOutput {
        provider_id: "kiro".into(),
        display_name: "Kiro".into(),
        plan: None,
        lines: vec![runtime::MetricLine::Progress {
            label: "Credits".into(),
            limit_resource_key: None,
            used,
            limit: 100.0,
            format: runtime::ProgressFormat::Count {
                suffix: "credits".into(),
            },
            resets_at: None,
            period_duration_ms: None,
            color: None,
        }],
        icon_url: String::new(),
    }
}
#[test]
#[serial_test::serial]
fn kiro_source_change_rejects_late_probe_old_cache_and_failed_new_source_ui_data() {
    let credentials = Credentials::new();
    credentials.write("account-a");
    let dir = tempfile::tempdir().unwrap();
    cache::init_with_catalog(
        dir.path(),
        dir.path(),
        vec!["kiro".into()],
        vec![],
        "test".into(),
    );
    let source_a = crate::kiro_sources::snapshot().unwrap();
    let plugin = crate::plugin_engine::manifest::load_plugins_from_dir(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
    )
    .into_iter()
    .find(|plugin| plugin.manifest.id == "kiro")
    .unwrap();
    let probe = Probe {
        plugin: plugin.clone(),
        output: output(20.0),
        started_at: time::OffsetDateTime::now_utc(),
        preparation_error: None,
        fingerprint: source_a.fingerprint.clone(),
        values: HashMap::new(),
        environment: source_a.environment,
        deadline: Instant::now() + Duration::from_secs(30),
    };
    assert!(probe.publish(|_, _| Ok(())).is_ok());
    cache::flush_cache().unwrap();
    assert!(cache::snapshot_for_provider("kiro").is_some());
    let failure = runtime::provider_account_probe_error(
        &plugin,
        "Kiro CLI usage request failed. Check your connection.",
    );
    assert!(
        !invalidate_failed_output(&failure),
        "same-source stale data stays available"
    );

    credentials.write("account-b");
    assert!(probe
        .publish::<()>(|_, _| panic!("old-source output must never publish"))
        .is_err());
    assert!(cache::snapshot_for_provider("kiro").is_none());
    assert!(!cache::load_cache(dir.path()).contains_key("kiro"));
    assert!(
        invalidate_failed_output(&failure),
        "a failed new-source refresh clears old UI data"
    );
    assert!(cache::cache_configured_output(
        &output(20.0),
        time::OffsetDateTime::now_utc(),
        &source_a.fingerprint
    )
    .is_err());

    let source_b = crate::kiro_sources::snapshot().unwrap();
    let current_probe = |result| Probe {
        plugin: plugin.clone(),
        output: result,
        started_at: time::OffsetDateTime::now_utc(),
        preparation_error: None,
        fingerprint: source_b.fingerprint.clone(),
        values: HashMap::new(),
        environment: source_b.environment.clone(),
        deadline: Instant::now() + Duration::from_secs(30),
    };
    current_probe(failure.clone())
        .publish(|_, _| Ok(()))
        .unwrap();
    assert!(
        cache::snapshot_for_provider("kiro").is_none(),
        "failed B must not republish A's 20"
    );
    assert!(invalidate_failed_output(&failure));
    current_probe(output(60.0)).publish(|_, _| Ok(())).unwrap();
    cache::flush_cache().unwrap();
    let before_failure = cache::snapshot_for_provider("kiro").unwrap();
    assert_eq!(
        serde_json::to_value(&before_failure).unwrap()["lines"][0]["used"],
        60.0
    );
    current_probe(failure.clone())
        .publish(|_, _| Ok(()))
        .unwrap();
    assert!(!invalidate_failed_output(&failure));
    let retained = cache::snapshot_for_provider("kiro").unwrap();
    assert_eq!(
        serde_json::to_value(&retained).unwrap()["lines"][0]["used"],
        60.0
    );
    assert_eq!(
        retained.started_at, before_failure.started_at,
        "failure must not claim new freshness"
    );
}
