use super::*;
use std::time::Instant;

fn ensure_report_time(deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        log::warn!("Ollama report connection time limit reached");
        return Err("报告读取已超时，请稍后重试。".into());
    }
    Ok(())
}

pub(crate) struct ReportConnection {
    pub configuration: Option<std::collections::HashMap<String, serde_json::Value>>,
    pub stamp: String,
    pub connection_id: Option<String>,
    pub uses_primary: bool,
}

pub(crate) fn report_connection(
    plugin: &LoadedPlugin,
    id: Option<&str>,
    deadline: Instant,
) -> Result<ReportConnection, String> {
    ensure_report_time(deadline)?;
    let id_is_primary_request = id.is_none();
    let _guard = store::lock_until(deadline)?;
    let stored = store::read()?;
    ensure_report_time(deadline)?;
    let id = match (id, &stored.primary) {
        (Some(id), _) => Some(id),
        (None, Primary::Connection { connection_id }) => Some(connection_id.as_str()),
        (None, Primary::Legacy) => None,
        (None, Primary::None) => return Err("尚未设置主账号，请先选择账号。".into()),
    };
    if let Some(id) = id {
        let r = stored
            .connections
            .iter()
            .find(|r| r.connection_id == id)
            .ok_or_else(store::changed)?;
        let uses_primary = id_is_primary_request;
        let stamp = crate::safe_file::sha256_hex(
            serde_json::json!([
                r.connection_id,
                r.revision,
                r.api_key,
                if uses_primary {
                    Some(generation_before(plugin, &stored, deadline)?)
                } else {
                    None
                }
            ])
            .to_string()
            .as_bytes(),
        );
        let mut configuration = runtime::configuration(&r.api_key);
        configuration.insert(
            "managedAccountFingerprint".into(),
            serde_json::json!(r.identity_fingerprint),
        );
        Ok(ReportConnection {
            configuration: Some(configuration),
            stamp,
            connection_id: Some(id.into()),
            uses_primary,
        })
    } else {
        let configuration = legacy::configuration_before(plugin, deadline);
        ensure_report_time(deadline)?;
        if !legacy::still_current(plugin, &configuration) {
            return Err(store::changed());
        }
        if let Some(error) = configuration.error {
            return Err(error.message);
        }
        let stamp = crate::safe_file::sha256_hex(
            serde_json::json!([
                stored.projection_revision,
                ["legacy", stored.legacy.revision, configuration.generation]
            ])
            .to_string()
            .as_bytes(),
        );
        Ok(ReportConnection {
            configuration: Some(configuration.values),
            stamp,
            connection_id: None,
            uses_primary: true,
        })
    }
}

pub(crate) fn report_connection_unchanged(
    plugin: &LoadedPlugin,
    captured: &ReportConnection,
    deadline: Instant,
) -> Result<(), String> {
    ensure_report_time(deadline)?;
    if !captured.uses_primary && captured.connection_id.is_none() {
        return if report_legacy_connection(plugin, deadline)?.stamp == captured.stamp {
            Ok(())
        } else {
            Err(store::changed())
        };
    }
    let current = report_connection(
        plugin,
        if captured.uses_primary {
            None
        } else {
            captured.connection_id.as_deref()
        },
        deadline,
    )?;
    if current.stamp != captured.stamp {
        return Err(store::changed());
    }
    Ok(())
}

pub(crate) fn report_legacy_connection(
    plugin: &LoadedPlugin,
    deadline: Instant,
) -> Result<ReportConnection, String> {
    ensure_report_time(deadline)?;
    let configuration = legacy::configuration_before(plugin, deadline);
    ensure_report_time(deadline)?;
    if let Some(error) = configuration.error {
        return Err(error.message);
    }
    let _guard = store::lock_until(deadline)?;
    ensure_report_time(deadline)?;
    if !legacy::still_current(plugin, &configuration) {
        return Err(store::changed());
    }
    let stored = store::read()?;
    let stamp = crate::safe_file::sha256_hex(
        serde_json::json!([
            "legacy-report",
            stored.legacy.revision,
            configuration.generation
        ])
        .to_string()
        .as_bytes(),
    );
    Ok(ReportConnection {
        configuration: Some(configuration.values),
        stamp,
        connection_id: None,
        uses_primary: false,
    })
}
