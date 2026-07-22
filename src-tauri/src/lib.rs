#[cfg(target_os = "macos")]
mod app_nap;
mod app_paths;
pub mod cli;
mod cli_installer;
mod config;
mod local_http_api;
mod log_path;
mod notifications;
#[cfg(target_os = "macos")]
mod panel;
#[cfg(not(target_os = "macos"))]
#[path = "panel_standard.rs"]
mod panel;
#[cfg(all(test, target_os = "macos"))]
#[allow(dead_code)]
#[path = "panel_standard.rs"]
mod panel_standard_tests;
mod platform_capabilities;
mod plugin_engine;
mod provider_config;
mod provider_status;
mod safe_file;
mod tray;
mod usage_reader;
#[cfg(target_os = "macos")]
mod webkit_config;
mod windows_autostart;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_aptabase::EventTracker;
use tauri_plugin_log::{Target, TargetKind};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(target_os = "macos")]
const GLOBAL_SHORTCUT_STORE_KEY: &str = "globalShortcut";
const DAILY_ACTIVE_TRACKED_DAY_KEY: &str = "analytics.daily_active_day";
const DAILY_ACTIVE_EVENT_NAME: &str = "app_started";
const MAX_CONCURRENT_PROBES: usize = 4;

fn is_autostart_launch(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| argument == "--autostart")
}

fn probe_worker_count(plugin_count: usize) -> usize {
    plugin_count.min(MAX_CONCURRENT_PROBES)
}

fn today_utc_ymd() -> String {
    let date = time::OffsetDateTime::now_utc().date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month() as u8,
        date.day()
    )
}

fn should_track_daily_active(last_tracked_day: Option<&str>, today: &str) -> bool {
    match last_tracked_day {
        Some(day) => day != today,
        None => true,
    }
}

#[cfg(desktop)]
fn track_daily_active_if_needed(app_handle: &tauri::AppHandle) {
    use tauri_plugin_store::StoreExt;

    let today = today_utc_ymd();

    let store = match app_handle.store("settings.json") {
        Ok(store) => store,
        Err(error) => {
            log::warn!(
                "Failed to access settings store for daily analytics gate: {}",
                error
            );
            return;
        }
    };

    let last_tracked_day = store
        .get(DAILY_ACTIVE_TRACKED_DAY_KEY)
        .and_then(|value| value.as_str().map(|value| value.to_string()));

    if !should_track_daily_active(last_tracked_day.as_deref(), &today) {
        return;
    }

    if let Err(error) = app_handle.track_event(DAILY_ACTIVE_EVENT_NAME, None) {
        log::warn!("Failed to track daily analytics event: {}", error);
        return;
    }

    store.set(
        DAILY_ACTIVE_TRACKED_DAY_KEY,
        serde_json::Value::String(today),
    );
    if let Err(error) = store.save() {
        log::warn!("Failed to save daily analytics tracked day: {}", error);
    }
}

#[cfg(not(desktop))]
fn track_daily_active_if_needed(app_handle: &tauri::AppHandle) {
    let _ = app_handle.track_event(DAILY_ACTIVE_EVENT_NAME, None);
}

#[cfg(desktop)]
fn seconds_until_next_utc_day(now: time::OffsetDateTime) -> u64 {
    let now_time = now.time();
    let seconds_since_midnight = u64::from(now_time.hour()) * 60 * 60
        + u64::from(now_time.minute()) * 60
        + u64::from(now_time.second());
    let seconds_until_next_day = 86_400_u64.saturating_sub(seconds_since_midnight);
    if seconds_until_next_day == 0 {
        86_400
    } else {
        seconds_until_next_day
    }
}

#[cfg(desktop)]
fn spawn_daily_active_rollover_tracker(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let sleep_for = std::time::Duration::from_secs(seconds_until_next_utc_day(
                time::OffsetDateTime::now_utc(),
            ));
            std::thread::sleep(sleep_for);
            track_daily_active_if_needed(&app_handle);
        }
    });
}

#[cfg(target_os = "macos")]
fn managed_shortcut_slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Shared shortcut handler that toggles the panel when the shortcut is pressed.
#[cfg(target_os = "macos")]
fn handle_global_shortcut(
    app: &tauri::AppHandle,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state == ShortcutState::Pressed {
        log::debug!("Global shortcut triggered");
        panel::toggle_panel(app);
    }
}

pub struct AppState {
    pub plugins: Vec<plugin_engine::manifest::LoadedPlugin>,
    pub app_data_dir: PathBuf,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub icon_url: String,
    pub brand_color: Option<String>,
    pub lines: Vec<ManifestLineDto>,
    pub links: Vec<PluginLinkDto>,
    pub status_page: Option<PluginStatusPageDto>,
    pub config: Option<PluginConfigDto>,
    /// Ordered list of primary metric candidates (sorted by primaryOrder).
    /// Frontend picks the first one that exists in runtime data.
    pub primary_candidates: Vec<String>,
    /// Label of the progress line marked `"period": "weekly"`, if any.
    /// Drives the menubar weekly-metric preference.
    pub weekly_candidate: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLineDto {
    #[serde(rename = "type")]
    pub line_type: String,
    pub label: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLinkDto {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusPageDto {
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigDto {
    pub fields: Vec<ConfigFieldDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFieldDto {
    pub id: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub label: String,
    pub placeholder: Option<String>,
    pub help: Option<String>,
    pub options: Vec<ConfigOptionDto>,
    pub default: Option<serde_json::Value>,
    pub default_source: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOptionDto {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatchStarted {
    pub batch_id: String,
    pub plugin_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub batch_id: String,
    pub output: plugin_engine::runtime::PluginOutput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatchComplete {
    pub batch_id: String,
}

#[tauri::command]
fn init_panel(app_handle: tauri::AppHandle) -> Result<(), String> {
    panel::init(&app_handle).map_err(|error| {
        log::error!("failed to initialize panel: {error}");
        error.to_string()
    })
}

#[tauri::command]
fn hide_panel(app_handle: tauri::AppHandle) {
    panel::hide_panel(&app_handle);
}

#[tauri::command]
fn reposition_panel(app_handle: tauri::AppHandle) {
    panel::reposition_visible_panel(&app_handle);
}

#[tauri::command]
fn open_devtools(#[allow(unused)] app_handle: tauri::AppHandle) {
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        if let Some(window) = app_handle.get_webview_window("main") {
            window.open_devtools();
        }
    }
}

#[tauri::command]
async fn start_probe_batch(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    batch_id: Option<String>,
    plugin_ids: Option<Vec<String>>,
) -> Result<ProbeBatchStarted, String> {
    let batch_id = batch_id
        .and_then(|id| {
            let trimmed = id.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let (plugins, app_data_dir, app_version) = {
        let locked = state.lock().map_err(|e| e.to_string())?;
        (
            locked.plugins.clone(),
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };

    let selected_plugins = match plugin_ids {
        Some(ids) => {
            let mut by_id: HashMap<String, plugin_engine::manifest::LoadedPlugin> = plugins
                .into_iter()
                .map(|plugin| (plugin.manifest.id.clone(), plugin))
                .collect();
            let mut seen = HashSet::new();
            ids.into_iter()
                .filter_map(|id| {
                    if !seen.insert(id.clone()) {
                        return None;
                    }
                    by_id.remove(&id)
                })
                .collect()
        }
        None => plugins,
    };

    let response_plugin_ids: Vec<String> = selected_plugins
        .iter()
        .map(|plugin| plugin.manifest.id.clone())
        .collect();

    log::info!(
        "probe batch {} starting: {:?}",
        batch_id,
        response_plugin_ids
    );

    if selected_plugins.is_empty() {
        let _ = app_handle.emit(
            "probe:batch-complete",
            ProbeBatchComplete {
                batch_id: batch_id.clone(),
            },
        );
        return Ok(ProbeBatchStarted {
            batch_id,
            plugin_ids: response_plugin_ids,
        });
    }

    let selected_count = selected_plugins.len();
    let worker_count = probe_worker_count(selected_count);
    if worker_count < selected_count {
        log::info!(
            "probe batch {} using {} workers for {} plugins",
            batch_id,
            worker_count,
            selected_count
        );
    }

    let remaining = Arc::new(AtomicUsize::new(selected_count));
    let probe_queue = Arc::new(Mutex::new(
        selected_plugins.into_iter().collect::<VecDeque<_>>(),
    ));

    for _ in 0..worker_count {
        let handle = app_handle.clone();
        let completion_handle = app_handle.clone();
        let bid = batch_id.clone();
        let completion_bid = batch_id.clone();
        let data_dir = app_data_dir.clone();
        let version = app_version.clone();
        let counter = Arc::clone(&remaining);
        let queue = Arc::clone(&probe_queue);

        tauri::async_runtime::spawn_blocking(move || {
            loop {
                let plugin = {
                    let mut queue = queue
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    queue.pop_front()
                };

                let Some(plugin) = plugin else {
                    break;
                };

                let plugin_id = plugin.manifest.id.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    plugin_engine::runtime::run_probe(&plugin, &data_dir, &version)
                }));

                match result {
                    Ok(output) => {
                        if let Some(message) = plugin_engine::runtime::probe_error_message(&output)
                        {
                            log::warn!("probe {} completed with error", plugin_id);
                            local_http_api::record_probe_error(
                                &plugin_id,
                                plugin_engine::host_api::redact_log_message(message),
                            );
                        } else {
                            log::info!(
                                "probe {} completed ok ({} lines)",
                                plugin_id,
                                output.lines.len()
                            );
                            local_http_api::cache_successful_output(&output);
                        }
                        let _ = handle.emit(
                            "probe:result",
                            ProbeResult {
                                batch_id: bid.clone(),
                                output,
                            },
                        );
                    }
                    Err(_) => {
                        log::error!("probe {} panicked", plugin_id);
                        let output = plugin_engine::runtime::panic_probe_output(&plugin);
                        local_http_api::record_probe_error(
                            &plugin_id,
                            "The plugin crashed during refresh.",
                        );
                        let _ = handle.emit(
                            "probe:result",
                            ProbeResult {
                                batch_id: bid.clone(),
                                output,
                            },
                        );
                    }
                }

                if counter.fetch_sub(1, Ordering::SeqCst) == 1 {
                    log::info!("probe batch {} complete", completion_bid);
                    let _ = completion_handle.emit(
                        "probe:batch-complete",
                        ProbeBatchComplete {
                            batch_id: completion_bid.clone(),
                        },
                    );
                }
            }
        });
    }

    Ok(ProbeBatchStarted {
        batch_id,
        plugin_ids: response_plugin_ids,
    })
}

fn plugin_config_fields(
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: &str,
) -> Result<Vec<plugin_engine::manifest::PluginConfigField>, String> {
    let locked = state.lock().map_err(|e| e.to_string())?;
    let plugin = locked
        .plugins
        .iter()
        .find(|plugin| plugin.manifest.id == plugin_id)
        .ok_or_else(|| format!("Unknown plugin '{plugin_id}'"))?;
    Ok(plugin
        .manifest
        .config
        .as_ref()
        .map(|config| config.fields.clone())
        .unwrap_or_default())
}

fn plugin_config_dto(config: &plugin_engine::manifest::PluginConfig) -> PluginConfigDto {
    PluginConfigDto {
        fields: config
            .fields
            .iter()
            .map(|field| ConfigFieldDto {
                id: field.id.clone(),
                field_type: match field.field_type {
                    plugin_engine::manifest::PluginConfigFieldType::Secret => "secret",
                    plugin_engine::manifest::PluginConfigFieldType::Text => "text",
                    plugin_engine::manifest::PluginConfigFieldType::Select => "select",
                    plugin_engine::manifest::PluginConfigFieldType::Toggle => "toggle",
                }
                .to_string(),
                label: field.label.clone(),
                placeholder: field.placeholder.clone(),
                help: field.help.clone(),
                options: field
                    .options
                    .iter()
                    .map(|option| ConfigOptionDto {
                        value: option.value.clone(),
                        label: option.label.clone(),
                    })
                    .collect(),
                default: field.default.clone(),
                default_source: field.default_source,
            })
            .collect(),
    }
}

#[tauri::command]
fn get_provider_config(
    plugin_id: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<provider_config::ProviderConfigView, String> {
    let fields = plugin_config_fields(state, &plugin_id)?;
    Ok(provider_config::view_for_plugin(&plugin_id, &fields))
}

#[tauri::command]
fn save_provider_config(
    plugin_id: String,
    values: HashMap<String, serde_json::Value>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let fields = plugin_config_fields(state, &plugin_id)?;
    if fields.is_empty() && !values.is_empty() {
        return Err(format!("Plugin '{plugin_id}' has no configurable fields"));
    }
    provider_config::save_plugin_values(&plugin_id, &fields, values)
}

#[tauri::command]
fn delete_provider_config_field(
    plugin_id: String,
    field_id: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let fields = plugin_config_fields(state, &plugin_id)?;
    provider_config::delete_plugin_field(&plugin_id, &fields, &field_id)
}

#[tauri::command]
fn get_log_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    log_path::for_app(&app_handle).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_local_http_api_status() -> local_http_api::LocalHttpApiServiceStatus {
    local_http_api::get_status()
}

/// Update the global shortcut registration.
/// Pass `null` to disable the shortcut, or a shortcut string like "CommandOrControl+Shift+U".
#[cfg(target_os = "macos")]
#[tauri::command]
fn update_global_shortcut(
    app_handle: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<(), String> {
    let global_shortcut = app_handle.global_shortcut();
    let normalized_shortcut = shortcut.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let mut managed_shortcut = managed_shortcut_slot()
        .lock()
        .map_err(|e| format!("failed to lock managed shortcut state: {}", e))?;

    if *managed_shortcut == normalized_shortcut {
        log::debug!("Global shortcut unchanged");
        return Ok(());
    }

    let previous_shortcut = managed_shortcut.clone();
    if let Some(existing) = previous_shortcut.as_deref() {
        match global_shortcut.unregister(existing) {
            Ok(()) => {
                // Keep in-memory state aligned with actual registration state.
                *managed_shortcut = None;
            }
            Err(e) => {
                log::warn!(
                    "Failed to unregister existing shortcut '{}': {}",
                    existing,
                    e
                );
            }
        }
    }

    if let Some(shortcut) = normalized_shortcut {
        log::info!("Registering global shortcut: {}", shortcut);
        global_shortcut
            .on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
                handle_global_shortcut(app, event);
            })
            .map_err(|e| format!("Failed to register shortcut '{}': {}", shortcut, e))?;
        *managed_shortcut = Some(shortcut);
    } else {
        log::info!("Global shortcut disabled");
        *managed_shortcut = None;
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn update_global_shortcut(
    _app_handle: tauri::AppHandle,
    _shortcut: Option<String>,
) -> Result<(), String> {
    Err("Global shortcuts are not supported on this platform.".to_string())
}

#[tauri::command]
fn list_plugins(state: tauri::State<'_, Mutex<AppState>>) -> Vec<PluginMeta> {
    let plugins = {
        let locked = state.lock().expect("plugin state poisoned");
        locked.plugins.clone()
    };
    log::debug!("list_plugins: {} plugins", plugins.len());

    plugins
        .into_iter()
        .map(|plugin| {
            // Extract primary candidates: progress lines with primary_order, sorted by order
            let mut candidates: Vec<_> = plugin
                .manifest
                .lines
                .iter()
                .filter(|line| line.line_type == "progress" && line.primary_order.is_some())
                .collect();
            candidates.sort_by_key(|line| line.primary_order.unwrap());
            let primary_candidates: Vec<String> =
                candidates.iter().map(|line| line.label.clone()).collect();

            // The weekly metric is the progress line declared `"period": "weekly"`.
            let weekly_candidate: Option<String> =
                plugin_engine::manifest::weekly_candidate(&plugin.manifest.lines)
                    .map(str::to_string);

            PluginMeta {
                id: plugin.manifest.id,
                name: plugin.manifest.name,
                icon_url: plugin.icon_data_url,
                brand_color: plugin.manifest.brand_color,
                lines: plugin
                    .manifest
                    .lines
                    .iter()
                    .map(|line| ManifestLineDto {
                        line_type: line.line_type.clone(),
                        label: line.label.clone(),
                        scope: line.scope.clone(),
                    })
                    .collect(),
                links: plugin
                    .manifest
                    .links
                    .iter()
                    .map(|link| PluginLinkDto {
                        label: link.label.clone(),
                        url: link.url.clone(),
                    })
                    .collect(),
                status_page: plugin.manifest.status_page.as_ref().map(|status_page| {
                    PluginStatusPageDto {
                        url: status_page.url.clone(),
                    }
                }),
                config: plugin.manifest.config.as_ref().map(plugin_config_dto),
                primary_candidates,
                weekly_candidate,
            }
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = runtime.enter();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if is_autostart_launch(&args) {
                log::info!("Ignoring duplicate autostart activation");
                return;
            }
            log::info!("Secondary OpenUsageCN instance requested; showing existing panel");
            panel::show_panel(app);
        }))
        .plugin(tauri_plugin_aptabase::Builder::new("A-US-6435241436").build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    let builder = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .max_file_size(10_000_000) // 10 MB
                .level(log::LevelFilter::Trace) // Allow all levels; runtime filter via tray menu
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Info)
                .level_for("tauri_plugin_updater", log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_process::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--autostart")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            init_panel,
            hide_panel,
            reposition_panel,
            open_devtools,
            start_probe_batch,
            list_plugins,
            get_provider_config,
            save_provider_config,
            delete_provider_config_field,
            get_log_path,
            get_local_http_api_status,
            platform_capabilities::get_platform_capabilities,
            windows_autostart::repair_windows_autostart_command,
            provider_status::get_provider_status,
            cli_installer::get_cli_install_status,
            cli_installer::set_cli_installed,
            notifications::get_notification_permission,
            notifications::request_notification_permission,
            notifications::post_pace_notification,
            notifications::open_notification_settings,
            update_global_shortcut
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                app_nap::disable_app_nap();
                webkit_config::disable_webview_suspension(app.handle());
                notifications::register_delegate(app.handle().clone());
            }

            use tauri::Manager;

            let version = app.package_info().version.to_string();
            log::info!("OpenUsageCN v{} starting", version);

            #[cfg(not(target_os = "macos"))]
            panel::init(app.handle())?;

            let app_data_dir =
                app_paths::sensitive_data_dir(app.handle()).expect("no sensitive app data dir");
            let settings_data_dir = app.path().app_data_dir().expect("no settings app data dir");
            #[cfg(target_os = "windows")]
            {
                provider_config::initialize_path(app_data_dir.join("providers.json"));
                config::initialize_path(app_data_dir.join("config.json"));
            }

            // Load config early (lazy init via OnceLock, zero-cost after)
            config::initialize_proxy();

            track_daily_active_if_needed(app.handle());
            #[cfg(desktop)]
            spawn_daily_active_rollover_tracker(app.handle().clone());

            let resource_dir = app.path().resource_dir().expect("no resource dir");
            let app_data_dir_tail = app_data_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown");
            let redacted_app_data_dir =
                plugin_engine::host_api::redact_log_message(&app_data_dir.display().to_string());
            log::debug!(
                "app_data_dir: tail={}, path={}",
                app_data_dir_tail,
                redacted_app_data_dir
            );

            let (_, plugins) = plugin_engine::initialize_plugins(&app_data_dir, &resource_dir);
            let plugins = plugin_engine::plugins_for_current_platform(plugins);
            let known_plugin_ids: Vec<String> =
                plugins.iter().map(|p| p.manifest.id.clone()).collect();
            let limit_catalog = local_http_api::limits::catalog_from_plugins(&plugins);
            provider_config::register_existing_secrets(&plugins);
            app.manage(Mutex::new(AppState {
                plugins,
                app_data_dir: app_data_dir.clone(),
                app_version: app.package_info().version.to_string(),
            }));

            local_http_api::init_with_catalog(
                &app_data_dir,
                &settings_data_dir,
                known_plugin_ids,
                limit_catalog,
                version.clone(),
            );
            local_http_api::start_server();

            tray::create(app.handle())?;

            #[cfg(target_os = "windows")]
            if !is_autostart_launch(&std::env::args().collect::<Vec<_>>()) {
                panel::show_panel(app.handle());
            }

            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Register global shortcut from stored settings
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_store::StoreExt;

                if let Ok(store) = app.handle().store("settings.json") {
                    if let Some(shortcut_value) = store.get(GLOBAL_SHORTCUT_STORE_KEY) {
                        if let Some(shortcut) = shortcut_value.as_str() {
                            let shortcut = shortcut.trim();
                            if !shortcut.is_empty() {
                                let handle = app.handle().clone();
                                log::info!("Registering initial global shortcut: {}", shortcut);
                                if let Err(e) = handle.global_shortcut().on_shortcut(
                                    shortcut,
                                    |app, _shortcut, event| {
                                        handle_global_shortcut(app, event);
                                    },
                                ) {
                                    log::warn!("Failed to register initial global shortcut: {}", e);
                                } else if let Ok(mut managed_shortcut) =
                                    managed_shortcut_slot().lock()
                                {
                                    *managed_shortcut = Some(shortcut.to_string());
                                } else {
                                    log::warn!("Failed to store managed shortcut in memory");
                                }
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Err(error) = local_http_api::flush_cache() {
                    log::error!("failed to flush usage cache during shutdown: {error}");
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        DAILY_ACTIVE_TRACKED_DAY_KEY, MAX_CONCURRENT_PROBES, is_autostart_launch,
        plugin_config_dto, probe_worker_count, seconds_until_next_utc_day,
        should_track_daily_active,
    };
    use crate::plugin_engine::manifest::{
        PluginConfig, PluginConfigField, PluginConfigFieldType, PluginConfigOption,
    };
    use serde_json::json;
    use time::{Date, Month, PrimitiveDateTime, Time};

    #[test]
    fn should_track_when_no_previous_day() {
        assert!(should_track_daily_active(None, "2026-02-12"));
    }

    #[test]
    fn should_not_track_when_same_day() {
        assert!(!should_track_daily_active(Some("2026-02-12"), "2026-02-12"));
    }

    #[test]
    fn should_track_when_day_changes() {
        assert!(should_track_daily_active(Some("2026-02-11"), "2026-02-12"));
    }

    #[test]
    fn daily_active_key_is_not_version_scoped() {
        assert_eq!(DAILY_ACTIVE_TRACKED_DAY_KEY, "analytics.daily_active_day");
        assert!(!DAILY_ACTIVE_TRACKED_DAY_KEY.contains("0.6.2"));
        assert!(!DAILY_ACTIVE_TRACKED_DAY_KEY.contains("0.6.3"));
    }

    #[test]
    fn rollover_sleep_waits_for_next_utc_day_boundary() {
        let now = PrimitiveDateTime::new(
            Date::from_calendar_date(2026, Month::February, 12).unwrap(),
            Time::from_hms(23, 59, 50).unwrap(),
        )
        .assume_utc();

        assert_eq!(seconds_until_next_utc_day(now), 10);
    }

    #[test]
    fn probe_worker_count_is_bounded() {
        assert_eq!(probe_worker_count(0), 0);
        assert_eq!(probe_worker_count(1), 1);
        assert_eq!(
            probe_worker_count(MAX_CONCURRENT_PROBES),
            MAX_CONCURRENT_PROBES
        );
        assert_eq!(
            probe_worker_count(MAX_CONCURRENT_PROBES + 1),
            MAX_CONCURRENT_PROBES
        );
    }

    #[test]
    fn recognizes_only_explicit_autostart_argument() {
        assert!(is_autostart_launch(&[
            "openusagecn".into(),
            "--autostart".into()
        ]));
        assert!(!is_autostart_launch(&[
            "openusagecn".into(),
            "--autostart-debug".into()
        ]));
    }

    #[test]
    fn plugin_config_dto_includes_field_declarations() {
        let dto = plugin_config_dto(&PluginConfig {
            fields: vec![PluginConfigField {
                id: "region".to_string(),
                field_type: PluginConfigFieldType::Select,
                label: "Region".to_string(),
                placeholder: Some("Choose Region".to_string()),
                help: Some("Select an API region".to_string()),
                options: vec![PluginConfigOption {
                    value: "cn".to_string(),
                    label: "China".to_string(),
                }],
                default: Some(json!("cn")),
                default_source: true,
            }],
        });

        assert_eq!(dto.fields.len(), 1);
        assert_eq!(dto.fields[0].id, "region");
        assert_eq!(dto.fields[0].field_type, "select");
        assert_eq!(dto.fields[0].label, "Region");
        assert_eq!(dto.fields[0].placeholder.as_deref(), Some("Choose Region"));
        assert_eq!(dto.fields[0].help.as_deref(), Some("Select an API region"));
        assert_eq!(dto.fields[0].options[0].value, "cn");
        assert_eq!(dto.fields[0].default, Some(json!("cn")));
        assert!(dto.fields[0].default_source);
    }
}
