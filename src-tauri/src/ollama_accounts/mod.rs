mod batch;
pub(crate) mod commands;
mod legacy;
mod model;
mod reports;
mod runtime;
mod store;

#[cfg(test)]
use batch::run_gui_probe;
pub(crate) use batch::run_gui_probe_before;
pub(crate) use reports::{
    report_connection, report_connection_unchanged, report_legacy_connection,
};

use crate::plugin_engine::{
    manifest::LoadedPlugin,
    runtime::{MetricLine, PluginOutput},
};
pub(crate) use model::{AccountsView, Operation, Primary, VerificationView};
use std::path::PathBuf;

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
    generation_before(
        plugin,
        stored,
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    )
}

fn generation_before(
    plugin: &LoadedPlugin,
    stored: &model::StoredAccounts,
    deadline: std::time::Instant,
) -> Result<String, String> {
    let value = match &stored.primary {
        Primary::Legacy => {
            serde_json::json!([
                "legacy",
                stored.legacy.revision,
                legacy::configuration_before(plugin, deadline).generation
            ])
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
    legacy::synchronize(
        plugin,
        std::time::Instant::now() + std::time::Duration::from_secs(10),
    )?;
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

pub(crate) fn with_projection_guard_before<T>(
    plugin: &LoadedPlugin,
    expected: Option<&str>,
    deadline: std::time::Instant,
    publish: impl FnOnce() -> T,
) -> Result<T, String> {
    with_projection_state_before(deadline, |stored| {
        if Some(generation_before(plugin, stored, deadline)?.as_str()) != expected {
            return Err(store::changed());
        }
        Ok(publish())
    })
}

fn with_projection_state<T>(
    work: impl FnOnce(&model::StoredAccounts) -> Result<T, String>,
) -> Result<T, String> {
    with_projection_state_before(
        std::time::Instant::now() + std::time::Duration::from_secs(10),
        work,
    )
}

fn with_projection_state_before<T>(
    deadline: std::time::Instant,
    work: impl FnOnce(&model::StoredAccounts) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = store::lock_until(deadline)?;
    match store::read() {
        Ok(stored) => work(&stored),
        Err(error) => {
            // Keep the store lock through cleanup so a valid replacement cannot publish between
            // the failed read and removal. A mere generation mismatch must preserve newer data.
            crate::local_http_api::cache::replace_cached_account_projection_before(
                "ollama", None, deadline,
            )?;
            Err(error)
        }
    }
}

pub(crate) fn restore_primary_projection(plugin: &LoadedPlugin) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    if let Err(error) = legacy::synchronize(plugin, deadline) {
        return with_projection_state_before(deadline, |_| Err(error));
    }
    with_projection_state_before(deadline, |stored| publish_cached_primary(stored, deadline))
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
    stored.legacy.revision = stored
        .legacy
        .revision
        .checked_add(1)
        .ok_or_else(store::changed)?;
    stored.legacy.configuration_generation = None;
    stored.legacy.snapshot = None;
    stored.legacy.last_updated_at = None;
    stored.legacy.error = None;
    let projection_changed = stored.primary == Primary::Legacy;
    store::write(&mut stored, projection_changed)?;
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
    if stored.primary == Primary::Legacy {
        let (Some(snapshot), Some(updated)) =
            (&stored.legacy.snapshot, &stored.legacy.last_updated_at)
        else {
            return None;
        };
        return Some(crate::local_http_api::cache::CachedPluginSnapshot {
            provider_id: "ollama".into(),
            display_name: snapshot.display_name.clone(),
            plan: snapshot.plan.clone(),
            lines: snapshot.lines.clone(),
            started_at: updated.clone(),
            fetched_at: updated.clone(),
        });
    }
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

fn publish_cached_primary(
    stored: &model::StoredAccounts,
    deadline: std::time::Instant,
) -> Result<(), String> {
    crate::local_http_api::cache::replace_cached_account_projection_before(
        "ollama",
        cached_snapshot(stored),
        deadline,
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
        let _guard = store::lock_until(deadline)?;
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
        Ok(None) => return legacy::refresh(plugin, dir, version, deadline).unwrap_or_else(fail),
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
    if let Err(error) = with_projection_guard_before(plugin, Some(&stamp), deadline, || ()) {
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
        let _guard = store::lock_until(deadline)?;
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
            .is_some_and(|e| matches!(e.code.as_str(), "identityChanged" | "authExpired"));
        store::write_before(&mut stored, projection_changed, Some(deadline))?;
        publish_cached_primary(&stored, deadline)?;
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
    let deadline = deadline.min(std::time::Instant::now() + std::time::Duration::from_secs(30));
    let _connection_guard = store::acquire_refresh(id, deadline)?;
    let captured = {
        let _guard = store::lock_until(deadline)?;
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
    let _guard = store::lock_until(deadline)?;
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
        .is_some_and(|e| matches!(e.code.as_str(), "identityChanged" | "authExpired"))
        && matches!(&stored.primary, Primary::Connection { connection_id } if connection_id == id);
    store::write_before(&mut stored, projection_changed, Some(deadline))?;
    if matches!(&stored.primary, Primary::Connection { connection_id } if connection_id == id) {
        publish_cached_primary(&stored, deadline)?;
    }
    Ok(())
}
