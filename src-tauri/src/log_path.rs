use std::path::{Path, PathBuf};

pub fn for_app(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let bundle_id = app_handle.config().identifier.clone();
    let package_name = app_handle.package_info().name.clone();
    Ok(log_file_path(&home, &bundle_id, &package_name))
}

fn log_file_path(home: &Path, bundle_id: &str, package_name: &str) -> PathBuf {
    home.join("Library")
        .join("Logs")
        .join(bundle_id)
        .join(format!("{}.log", package_name))
}

#[cfg(test)]
mod tests {
    use super::log_file_path;
    use std::path::PathBuf;

    #[test]
    fn builds_macos_log_file_path() {
        let path = log_file_path(
            &PathBuf::from("/Users/tester"),
            "com.openusage.app",
            "OpenUsage",
        );

        assert_eq!(
            path,
            PathBuf::from("/Users/tester/Library/Logs/com.openusage.app/OpenUsage.log")
        );
    }
}
