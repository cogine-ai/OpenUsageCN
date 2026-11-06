use super::*;
use std::io::Write;

pub(crate) fn configuration_fingerprint(plugin: &str) -> Result<String, String> {
    let fields = crate::configured_providers::config_fields(plugin)?;
    let values = resolved_values_from_disk(plugin, &fields)?;
    let names = crate::configured_providers::required_environment(&fields, &values);
    let environment = host_api::resolve_env_values_before(
        &names,
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    if !environment.unresolved.is_empty() {
        return Err("无法确认环境中的连接来源，请重试。".into());
    }
    fingerprint_at(&config_path()?, plugin, &environment.values)
}
fn fingerprint_at(
    path: &Path,
    plugin: &str,
    environment: &HashMap<String, Option<String>>,
) -> Result<String, String> {
    let (config, _) = read(path)?;
    let values: std::collections::BTreeMap<_, _> = config
        .providers
        .get(plugin)
        .into_iter()
        .flat_map(|values| values.iter())
        .collect();
    let environment: std::collections::BTreeMap<_, _> = environment.iter().collect();
    let bytes = serde_json::to_vec(&(values, environment)).map_err(|_| "无法确认连接设置。")?;
    Ok(crate::safe_file::sha256_hex(&bytes))
}

/// Shared by processes; lock order is the in-process writer, file, then usage cache.
pub(super) fn lock_config_file(path: &Path) -> Result<std::fs::File, String> {
    let parent = path.parent().ok_or("无法定位连接设置。")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法访问连接设置目录。")?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))
        .map_err(|_| "无法锁定连接设置。")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(_) => return Err("连接设置正在被其他操作使用，请稍后重试。".into()),
        }
    }
}

/// The writer lock covers identity checking and publication/config replacement together.
pub(crate) fn with_configuration_guard<T>(
    plugin: &str,
    fields: &[PluginConfigField],
    expected: &HashMap<String, Value>,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = save_lock()
        .lock()
        .map_err(|_| "连接设置暂不可用，请重试。")?;
    let _file_guard = lock_config_file(&config_path()?)?;
    if resolved_values_from_disk(plugin, fields)? != *expected {
        return Err("连接已更改，请重新刷新。".into());
    }
    commit()
}

/// A device grant can replace only the exact connection from which it was started.
pub(crate) fn save_login_values(
    plugin: &str,
    fields: &[PluginConfigField],
    expected: &HashMap<String, Value>,
    input: HashMap<String, Value>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    save_login_values_at(
        &config_path()?,
        plugin,
        fields,
        expected,
        input,
        before_commit,
    )
}

fn save_login_values_at(
    path: &Path,
    plugin: &str,
    fields: &[PluginConfigField],
    expected: &HashMap<String, Value>,
    input: HashMap<String, Value>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = save_lock()
        .lock()
        .map_err(|_| "连接设置暂不可用，请重试。")?;
    let _file_guard = lock_config_file(&path)?;
    let (mut config, original) = read(&path)?;
    let old = config.providers.get(plugin).cloned().unwrap_or_default();
    if resolve_values(fields, &old) != *expected {
        return Err("连接已更改，请重新授权。".into());
    }
    let values = merge_values(fields, old, input)?;
    register_secret_values(fields, &values);
    config.providers.insert(plugin.into(), values);
    let json = serde_json::to_string_pretty(&config).map_err(|_| "无法保存登录设置。")?;
    before_commit()?;
    let saved = if let Some(bytes) = original {
        crate::safe_file::write_text_if_unchanged(
            &path,
            &json,
            &crate::safe_file::sha256_hex(&bytes),
        )?
    } else {
        create_if_missing(&path, json.as_bytes())?
    };
    if !saved {
        return Err("连接设置已被其他操作修改，请重新授权。".into());
    }
    *store().lock().map_err(|_| "连接设置暂不可用，请重试。")? = config;
    LOAD_DEGRADED.store(false, Ordering::Release);
    Ok(())
}

fn read(path: &Path) -> Result<(ProviderConfigFile, Option<Vec<u8>>), String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let config =
                serde_json::from_slice(&bytes).map_err(|_| damaged_config_message(path))?;
            Ok((config, Some(bytes)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((default_file(), None)),
        Err(_) => Err("无法读取连接设置，请检查文件权限。".into()),
    }
}

// A hard link installs a fully written private file without replacing a concurrently created file.
fn create_if_missing(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    let parent = path.parent().ok_or("无法定位连接设置。")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建连接设置目录。")?;
    let temporary = parent.join(format!(".login-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| "无法创建登录设置。")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法写入登录设置。")?;
        drop(file);
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(_) => Err("无法保存登录设置。".into()),
        }
    })();
    if temporary.exists() {
        std::fs::remove_file(&temporary).map_err(|_| "无法清理登录临时文件。")?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_login_never_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        assert!(create_if_missing(&path, b"original").unwrap());
        assert!(!create_if_missing(&path, b"replacement").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn invalid_settings_are_not_recovered_or_rewritten_for_login() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        std::fs::write(&path, b"invalid-secret-settings").unwrap();
        assert!(read(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid-secret-settings");
    }
    fn muse_fields() -> Vec<PluginConfigField> {
        serde_json::from_value(serde_json::json!([
            {"id":"accessToken","type":"secret","label":"Token"},
            {"id":"tokenExpiresAt","type":"text","label":"Expiry"}
        ]))
        .unwrap()
    }
    #[test]
    fn fingerprints_are_per_provider_order_independent_and_include_environment_sources() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let environment = HashMap::from([("API_KEY".into(), Some("environment-a".into()))]);
        std::fs::write(&path, r#"{"providers":{"muse":{"accessToken":"dca:old","tokenExpiresAt":""},"cursor":{"secret":"original"}}}"#).unwrap();
        let original = fingerprint_at(&path, "muse", &environment).unwrap();
        std::fs::write(&path, r#"{"providers":{"cursor":{"secret":"unrelated-change"},"muse":{"tokenExpiresAt":"","accessToken":"dca:old"}}}"#).unwrap();
        assert_eq!(
            original,
            fingerprint_at(&path, "muse", &environment).unwrap()
        );
        assert_ne!(
            original,
            fingerprint_at(&path, "muse", &HashMap::new()).unwrap()
        );
        assert_ne!(
            original,
            fingerprint_at(
                &path,
                "muse",
                &HashMap::from([("API_KEY".into(), Some("environment-b".into()))])
            )
            .unwrap()
        );
        std::fs::write(
            &path,
            r#"{"providers":{"muse":{"accessToken":"dca:new","tokenExpiresAt":""}}}"#,
        )
        .unwrap();
        assert_ne!(
            original,
            fingerprint_at(&path, "muse", &environment).unwrap()
        );
        assert!(!original.contains("dca:"));
    }
    #[test]
    #[serial_test::serial]
    fn login_only_replaces_unchanged_muse_and_preserves_fresh_unrelated_credentials() {
        let previous = store().lock().unwrap().clone();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let old = serde_json::json!({"providers":{"muse":{"accessToken":"dca:old"},"cursor":{"encrypted":"cursor-safe-storage:v1:untouched"}}});
        std::fs::write(&path, old.to_string()).unwrap();
        let expected = resolved_values_from_path(&path, "muse", &muse_fields()).unwrap();
        save_login_values_at(
            &path,
            "muse",
            &muse_fields(),
            &expected,
            HashMap::from([("accessToken".into(), Value::String("dca:new".into()))]),
            || Ok(()),
        )
        .unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["providers"]["cursor"], old["providers"]["cursor"]);
        assert_eq!(written["providers"]["muse"]["accessToken"], "dca:new");
        let before = std::fs::read(&path).unwrap();
        assert!(save_login_values_at(
            &path,
            "muse",
            &muse_fields(),
            &expected,
            HashMap::new(),
            || panic!("must reject before mutation")
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        *store().lock().unwrap() = previous;
    }
    #[test]
    #[serial_test::serial]
    fn uncooperative_external_write_during_login_is_not_overwritten() {
        let previous = store().lock().unwrap().clone();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let expected = resolve_values(&muse_fields(), &HashMap::new());
        let external = r#"{"providers":{"cursor":{"encrypted":"external-new-value"}}}"#;
        let result = save_login_values_at(
            &path,
            "muse",
            &muse_fields(),
            &expected,
            HashMap::from([("accessToken".into(), Value::String("dca:new".into()))]),
            || {
                std::fs::write(&path, external).unwrap();
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), external);
        *store().lock().unwrap() = previous;
    }
}
