use crate::local_http_api;
use crate::plugin_engine;
use crate::plugin_engine::manifest::LoadedPlugin;
use crate::plugin_engine::runtime::{PluginOutput, probe_error_message};
use crate::provider_config;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_CONCURRENT_PROBES: usize = 4;

pub(crate) struct LimitsRead {
    pub envelope: local_http_api::limits::LimitsEnvelope,
    pub refresh_failed: bool,
    pub missing_snapshot: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LimitsReadError {
    UnknownProvider(String),
    NoDataDirectory,
    NoProviderPlugins,
}

pub(crate) fn read_limits_once(
    provider_id: Option<&str>,
    force: bool,
) -> Result<LimitsRead, LimitsReadError> {
    let app_data_dir = app_data_dir().ok_or(LimitsReadError::NoDataDirectory)?;
    let plugins = load_cli_plugins(&app_data_dir);
    if plugins.is_empty() {
        return Err(LimitsReadError::NoProviderPlugins);
    }

    provider_config::register_existing_secrets(&plugins);
    let known_provider_ids: Vec<String> = plugins
        .iter()
        .map(|plugin| plugin.manifest.id.clone())
        .collect();
    let catalog = local_http_api::limits::catalog_from_plugins(&plugins);
    local_http_api::init_with_catalog(
        &app_data_dir,
        known_provider_ids.clone(),
        catalog,
        env!("CARGO_PKG_VERSION").to_string(),
    );

    let selected_ids = match provider_id {
        Some(provider_id) => {
            if !known_provider_ids.iter().any(|known| known == provider_id) {
                return Err(LimitsReadError::UnknownProvider(provider_id.to_string()));
            }
            vec![provider_id.to_string()]
        }
        None => local_http_api::cache::enabled_provider_ids(),
    };

    let now = time::OffsetDateTime::now_utc();
    let refresh_ids: Vec<String> = selected_ids
        .iter()
        .filter(|provider_id| {
            force
                || local_http_api::cache::snapshot_for_provider(provider_id)
                    .map(|snapshot| local_http_api::limits::snapshot_is_stale(&snapshot, now))
                    .unwrap_or(true)
        })
        .cloned()
        .collect();
    let by_id: HashMap<String, LoadedPlugin> = plugins
        .into_iter()
        .map(|plugin| (plugin.manifest.id.clone(), plugin))
        .collect();
    let selected_plugins: Vec<LoadedPlugin> = refresh_ids
        .iter()
        .filter_map(|provider_id| by_id.get(provider_id).cloned())
        .collect();
    let (results, worker_failed) = run_probes(
        selected_plugins,
        app_data_dir.clone(),
        env!("CARGO_PKG_VERSION").to_string(),
    );

    let mut refresh_failed = worker_failed;
    for (provider_id, output) in results {
        if let Some(message) = probe_error_message(&output) {
            refresh_failed = true;
            let redacted = plugin_engine::host_api::redact_log_message(message);
            eprintln!("openusage: refresh failed for {provider_id}: {redacted}");
            local_http_api::record_probe_error(&provider_id, redacted);
        } else {
            local_http_api::cache_successful_output(&output);
        }
    }
    if let Err(error) = local_http_api::flush_cache() {
        refresh_failed = true;
        eprintln!("openusage: failed to persist refreshed limits: {error}");
    }

    let missing_snapshot = selected_ids
        .iter()
        .any(|provider_id| local_http_api::cache::snapshot_for_provider(provider_id).is_none());
    let envelope = local_http_api::limits::current_envelope(&selected_ids);
    refresh_failed |= !envelope.errors.is_empty();
    Ok(LimitsRead {
        envelope,
        refresh_failed,
        missing_snapshot,
    })
}

fn run_probes(
    plugins: Vec<LoadedPlugin>,
    app_data_dir: PathBuf,
    app_version: String,
) -> (Vec<(String, PluginOutput)>, bool) {
    if plugins.is_empty() {
        return (Vec::new(), false);
    }
    let worker_count = plugins.len().min(MAX_CONCURRENT_PROBES);
    let queue = Arc::new(Mutex::new(plugins.into_iter().collect::<VecDeque<_>>()));
    let results = Arc::new(Mutex::new(Vec::new()));
    let mut workers = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let results = Arc::clone(&results);
        let app_data_dir = app_data_dir.clone();
        let app_version = app_version.clone();
        workers.push(std::thread::spawn(move || {
            loop {
                let plugin = queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pop_front();
                let Some(plugin) = plugin else { break };
                let provider_id = plugin.manifest.id.clone();
                let output = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    plugin_engine::runtime::run_probe(&plugin, &app_data_dir, &app_version)
                }))
                .unwrap_or_else(|_| plugin_engine::runtime::panic_probe_output(&plugin));
                results
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push((provider_id, output));
            }
        }));
    }
    let mut worker_failed = false;
    for worker in workers {
        if worker.join().is_err() {
            worker_failed = true;
            eprintln!("openusage: a provider worker crashed");
        }
    }
    (
        Arc::try_unwrap(results)
            .expect("probe results still shared")
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        worker_failed,
    )
}

fn load_cli_plugins(app_data_dir: &Path) -> Vec<LoadedPlugin> {
    if let Some(resource_dir) = cli_resource_dir() {
        let loaded = if is_packaged_resource_dir(&resource_dir) {
            plugin_engine::initialize_installed_plugins(app_data_dir, &resource_dir).1
        } else {
            plugin_engine::initialize_plugins(app_data_dir, &resource_dir).1
        };
        if !loaded.is_empty() {
            return loaded;
        }
    }
    plugin_engine::manifest::load_plugins_from_dir(&app_data_dir.join("plugins"))
}

fn app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|path| path.join("ai.cogine.openusagecn"))
}

fn cli_resource_dir() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    cli_resource_dir_for_executable(&executable)
}

fn cli_resource_dir_for_executable(executable: &Path) -> Option<PathBuf> {
    let executable = executable.canonicalize().ok()?;
    bundled_resource_dir_for_executable(&executable)
}

fn bundled_resource_dir_for_executable(executable: &Path) -> Option<PathBuf> {
    let executable_dir = executable.parent()?;
    let contents_dir = executable_dir.parent()?;
    let app_dir = contents_dir.parent()?;
    if executable_dir.file_name().and_then(|name| name.to_str()) == Some("MacOS")
        && contents_dir.file_name().and_then(|name| name.to_str()) == Some("Contents")
        && app_dir.extension().and_then(|extension| extension.to_str()) == Some("app")
    {
        return Some(contents_dir.join("Resources"));
    }
    None
}

fn is_packaged_resource_dir(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("Resources")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("Contents")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_path_uses_tauri_identifier() {
        let path = app_data_dir().unwrap();
        assert!(path.ends_with("ai.cogine.openusagecn"));
    }

    #[test]
    fn recognizes_only_app_bundle_resource_directories() {
        assert!(is_packaged_resource_dir(Path::new(
            "/Applications/OpenUsageCN.app/Contents/Resources"
        )));
        assert!(!is_packaged_resource_dir(Path::new(
            "/Users/example/openusage/resources"
        )));
    }

    #[test]
    fn only_derives_resources_from_an_app_bundle_executable() {
        assert_eq!(
            bundled_resource_dir_for_executable(Path::new(
                "/Applications/OpenUsageCN.app/Contents/MacOS/openusagecn"
            )),
            Some(PathBuf::from(
                "/Applications/OpenUsageCN.app/Contents/Resources"
            ))
        );
        assert_eq!(
            bundled_resource_dir_for_executable(Path::new("/workspace/target/debug/openusagecn")),
            None
        );
        assert_eq!(
            bundled_resource_dir_for_executable(Path::new("/tmp/MacOS/openusagecn")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_an_installed_cli_symlink_back_to_the_app_bundle() {
        let root =
            std::env::temp_dir().join(format!("openusage-cli-resources-{}", uuid::Uuid::new_v4()));
        let executable = root.join("OpenUsageCN.app/Contents/MacOS/openusagecn");
        let resources = root.join("OpenUsageCN.app/Contents/Resources");
        let link = root.join("bin/openusage");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(&executable, "binary").unwrap();
        std::os::unix::fs::symlink(&executable, &link).unwrap();

        assert_eq!(
            cli_resource_dir_for_executable(&link),
            Some(resources.canonicalize().unwrap())
        );

        let copied_executable = root.join("untrusted/openusage");
        std::fs::create_dir_all(copied_executable.parent().unwrap()).unwrap();
        std::fs::write(&copied_executable, "binary").unwrap();
        assert_eq!(cli_resource_dir_for_executable(&copied_executable), None);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn envelope_errors_mark_limits_read_as_failed() {
        let envelope = local_http_api::limits::LimitsEnvelope {
            schema: local_http_api::limits::LIMITS_SCHEMA,
            generated_at: String::new(),
            providers: Default::default(),
            errors: vec![local_http_api::limits::LimitsError {
                provider_id: "codex".to_string(),
                message: "probe failed".to_string(),
            }],
        };
        let mut refresh_failed = false;
        refresh_failed |= !envelope.errors.is_empty();
        assert!(refresh_failed);
    }
}
