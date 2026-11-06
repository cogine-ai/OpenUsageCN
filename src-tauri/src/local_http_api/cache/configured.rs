//! Persisted usage must still belong to the currently configured connection.
use super::{snapshot_from_output, CachedPluginSnapshot};
use crate::plugin_engine::runtime::PluginOutput;

pub(crate) fn snapshot_is_current(snapshot: &CachedPluginSnapshot) -> bool {
    if !crate::configured_providers::supports(&snapshot.provider_id) {
        return true;
    }
    let Some(expected) = &snapshot.config_fingerprint else {
        return false;
    };
    match crate::provider_config::configuration_fingerprint(&snapshot.provider_id) {
        Ok(current) => current == *expected,
        Err(_) => {
            log::warn!("Configured provider cache could not verify its connection");
            false
        }
    }
}

pub(crate) fn cache_configured_output(
    output: &PluginOutput,
    started_at: time::OffsetDateTime,
    fingerprint: &str,
) -> Result<(), String> {
    if !crate::configured_providers::supports(&output.provider_id) {
        return Err("用量来源配置不受支持。".into());
    }
    let mut snapshot = snapshot_from_output(output, started_at);
    snapshot.config_fingerprint = Some(fingerprint.to_owned());
    if !snapshot_is_current(&snapshot) {
        return Err("连接来源已更改，请重新刷新。".into());
    }
    if !super::cache_snapshot(snapshot) {
        return Err("连接来源已更改，请重新刷新。".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "configured_tests.rs"]
mod tests;
