use std::path::PathBuf;

use tauri::Manager;

pub fn sensitive_data_dir(app_handle: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    return app_handle.path().app_local_data_dir();

    #[cfg(not(target_os = "windows"))]
    app_handle.path().app_data_dir()
}
