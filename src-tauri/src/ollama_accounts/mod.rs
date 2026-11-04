pub(crate) mod commands;
mod model;
mod runtime;
mod store;

use crate::plugin_engine::{
    manifest::LoadedPlugin,
    runtime::{MetricLine, PluginOutput},
};
pub(crate) use model::{AccountsView, Operation, Primary, VerificationView};
use std::{collections::BTreeMap, path::PathBuf};

#[cfg(test)]
mod tests;

#[cfg(test)]
thread_local! {
    static PRIMARY_PROBE_PREPARED: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const {
        std::cell::RefCell::new(None)
    };
}

pub(super) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

pub(super) fn output(
    plugin: &LoadedPlugin,
    plan: Option<String>,
    lines: Vec<MetricLine>,
) -> PluginOutput {
    PluginOutput {
        provider_id: "ollama".into(),
        display_name: plugin.manifest.name.clone(),
        icon_url: plugin.icon_data_url.clone(),
        plan,
        lines,
    }
}

fn generation(plugin: &LoadedPlugin, stored: &model::StoredAccounts) -> Result<String, String> {
    let value = match &stored.primary {
        Primary::Legacy => {
            let fields = plugin
                .manifest
                .config
                .as_ref()
                .map(|c| c.fields.as_slice())
                .unwrap_or(&[]);
            let values: BTreeMap<_, _> = crate::provider_config::resolved_values("ollama", fields)
                .into_iter()
                .collect();
            serde_json::json!(["legacy", values])
        }
        Primary::None => serde_json::json!(["none"]),
        Primary::Connection { connection_id } => {
            let record = stored
                .connections
                .iter()
                .find(|r| &r.connection_id == connection_id)
                .ok_or_else(store::changed)?;
            serde_json::json!([
                "managed",
                connection_id,
                record.revision,
                crate::safe_file::sha256_hex(record.api_key.as_bytes())
            ])
        }
    };
    Ok(crate::safe_file::sha256_hex(
        serde_json::json!([stored.projection_revision, value])
            .to_string()
            .as_bytes(),
    ))
}

pub(crate) fn projection_generation(plugin: &LoadedPlugin) -> Result<String, String> {
    let _guard = store::lock()?;
    generation(plugin, &store::read()?)
}

pub(crate) fn with_projection_guard<T>(
    plugin: &LoadedPlugin,
    expected: Option<&str>,
    publish: impl FnOnce() -> T,
) -> Result<T, String> {
    with_projection_state(|stored| {
        if Some(generation(plugin, stored)?.as_str()) != expected {
            return Err(store::changed());
        }
        Ok(publish())
    })
}

fn with_projection_state<T>(
    work: impl FnOnce(&model::StoredAccounts) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = store::lock()?;
    match store::read() {
        Ok(stored) => work(&stored),
        Err(error) => {
            // Keep the store lock through cleanup so a valid replacement cannot publish between
            // the failed read and removal. A mere generation mismatch must preserve newer data.
            crate::clear_ollama_projection()?;
            Err(error)
        }
    }
}

pub(crate) fn restore_primary_projection() -> Result<(), String> {
    with_projection_state(|stored| {
        if stored.primary == Primary::Legacy {
            return Ok(());
        }
        crate::local_http_api::cache::replace_cached_account_projection(
            "ollama",
            cached_snapshot(stored),
        )
    })
}

pub(crate) fn check_primary_projection() -> Result<(), String> {
    with_projection_state(|_| Ok(()))
}

#[cfg(test)]
pub(crate) fn uses_legacy_primary() -> Result<bool, String> {
    let _guard = store::lock()?;
    Ok(store::read()?.primary == Primary::Legacy)
}

pub(crate) fn with_legacy_configuration_change(
    work: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = store::lock()?;
    let mut stored = store::read()?;
    if stored.primary == Primary::Legacy {
        store::write(&mut stored, true)?;
    }
    work()
}

#[cfg(test)]
fn primary_cached_snapshot()
-> Result<Option<crate::local_http_api::cache::CachedPluginSnapshot>, String> {
    let _guard = store::lock()?;
    Ok(cached_snapshot(&store::read()?))
}

fn cached_snapshot(
    stored: &model::StoredAccounts,
) -> Option<crate::local_http_api::cache::CachedPluginSnapshot> {
    let Primary::Connection { connection_id } = &stored.primary else {
        return None;
    };
    let record = stored
        .connections
        .iter()
        .find(|r| &r.connection_id == connection_id)?;
    let (Some(snapshot), Some(updated)) = (&record.snapshot, &record.last_updated_at) else {
        return None;
    };
    Some(crate::local_http_api::cache::CachedPluginSnapshot {
        provider_id: "ollama".into(),
        display_name: snapshot.display_name.clone(),
        plan: snapshot.plan.clone(),
        lines: snapshot.lines.clone(),
        started_at: updated.clone(),
        fetched_at: updated.clone(),
    })
}

pub(super) fn legacy_configuration_generation(plugin: &LoadedPlugin) -> String {
    let fields = plugin
        .manifest
        .config
        .as_ref()
        .map(|c| c.fields.as_slice())
        .unwrap_or(&[]);
    let values: BTreeMap<_, _> = crate::provider_config::resolved_values("ollama", fields)
        .into_iter()
        .collect();
    crate::safe_file::sha256_hex(
        serde_json::to_string(&values)
            .unwrap_or_default()
            .as_bytes(),
    )
}

pub(crate) fn run_primary_probe(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
) -> PluginOutput {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let fail = |message: String| {
        crate::plugin_engine::runtime::provider_account_probe_error(plugin, &message)
    };
    let prepared = (|| {
        let _guard = store::lock()?;
        let stored = store::read()?;
        let stamp = generation(plugin, &stored)?;
        let record = match &stored.primary {
            Primary::Legacy => return Ok(None),
            Primary::None => {
                return Err("尚未设置主账号，请在管理 Key 中选择；原配置保持不变。".into());
            }
            Primary::Connection { connection_id } => stored
                .connections
                .iter()
                .find(|r| &r.connection_id == connection_id)
                .cloned()
                .ok_or_else(store::changed)?,
        };
        Ok(Some((stamp, record)))
    })();
    let (stamp, record) = match prepared {
        Ok(Some(prepared)) => prepared,
        Ok(None) => return crate::plugin_engine::runtime::run_probe(plugin, dir, version),
        Err(error) => return fail(error),
    };
    #[cfg(test)]
    if let Some(prepared) = PRIMARY_PROBE_PREPARED.with(|hook| hook.borrow_mut().take()) {
        prepared();
    }
    let _connection_guard = match store::acquire_refresh(&record.connection_id, deadline) {
        Ok(guard) => guard,
        Err(e) => return fail(e),
    };
    // A queued refresh must not use a key removed or replaced while another process held the lock.
    if let Err(error) = with_projection_guard(plugin, Some(&stamp), || ()) {
        return fail(error);
    }
    let result = runtime::probe_with_deadline(
        plugin,
        dir,
        version,
        &record.api_key,
        deadline,
        Some(&record.identity_fingerprint),
    );
    let committed = (|| {
        let _guard = store::lock()?;
        let mut stored = store::read()?;
        if generation(plugin, &stored)? != stamp {
            return Err(store::changed());
        }
        let target = stored
            .connections
            .iter_mut()
            .find(|r| r.connection_id == record.connection_id)
            .ok_or_else(store::changed)?;
        store::apply_probe(target, result, plugin);
        let output = target
            .error
            .as_ref()
            .map(|e| fail(e.message.clone()))
            .or_else(|| target.snapshot.clone())
            .ok_or_else(store::changed)?;
        let projection_changed = target
            .error
            .as_ref()
            .is_some_and(|e| e.code == "identityChanged");
        store::write(&mut stored, projection_changed)?;
        Ok(output)
    })();
    committed.unwrap_or_else(fail)
}

pub(super) fn refresh(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    id: &str,
    deadline: std::time::Instant,
) -> Result<(), String> {
    let _connection_guard = store::acquire_refresh(id, deadline)?;
    let captured = {
        let _guard = store::lock()?;
        store::read()?
            .connections
            .into_iter()
            .find(|r| r.connection_id == id)
            .ok_or_else(store::changed)?
    };
    let result = runtime::probe_with_deadline(
        plugin,
        dir,
        version,
        &captured.api_key,
        deadline,
        Some(&captured.identity_fingerprint),
    );
    let _guard = store::lock()?;
    let mut stored = store::read()?;
    let target = stored
        .connections
        .iter_mut()
        .find(|r| r.connection_id == id && r.revision == captured.revision)
        .ok_or_else(store::changed)?;
    store::apply_probe(target, result, plugin);
    let projection_changed = target
        .error
        .as_ref()
        .is_some_and(|e| e.code == "identityChanged")
        && matches!(&stored.primary, Primary::Connection { connection_id } if connection_id == id);
    store::write(&mut stored, projection_changed)
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
) -> Result<ReportConnection, String> {
    let id_is_primary_request = id.is_none();
    let _guard = store::lock()?;
    let stored = store::read()?;
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
                    Some(generation(plugin, &stored)?)
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
        Ok(ReportConnection {
            configuration: None,
            stamp: generation(plugin, &stored)?,
            connection_id: None,
            uses_primary: true,
        })
    }
}

pub(crate) fn report_connection_unchanged(
    plugin: &LoadedPlugin,
    captured: &ReportConnection,
) -> Result<(), String> {
    let current = report_connection(
        plugin,
        if captured.uses_primary {
            None
        } else {
            captured.connection_id.as_deref()
        },
    )?;
    if current.stamp != captured.stamp {
        return Err(store::changed());
    }
    Ok(())
}
