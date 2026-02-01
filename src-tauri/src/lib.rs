mod panel;
mod plugin_engine;
mod tray;

use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub plugins: Vec<plugin_engine::manifest::LoadedPlugin>,
    pub app_data_dir: PathBuf,
    pub app_version: String,
}

#[tauri::command]
fn init_panel(app_handle: tauri::AppHandle) {
    panel::init(&app_handle).expect("Failed to initialize panel");
}

#[tauri::command]
fn run_plugin_probes(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Vec<plugin_engine::runtime::PluginOutput> {
    let (plugins, app_data_dir, app_version) = {
        let locked = state.lock().expect("plugin state poisoned");
        (
            locked.plugins.clone(),
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };

    plugin_engine::runtime::run_all_probes(&plugins, &app_data_dir, &app_version)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![init_panel, run_plugin_probes])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            use tauri::Manager;

            let app_data_dir = app.path().app_data_dir().expect("no app data dir");
            let resource_dir = app.path().resource_dir().expect("no resource dir");

            let (_, plugins) = plugin_engine::initialize_plugins(&app_data_dir, &resource_dir);
            app.manage(Mutex::new(AppState {
                plugins,
                app_data_dir,
                app_version: app.package_info().version.to_string(),
            }));

            tray::create(app.handle())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
