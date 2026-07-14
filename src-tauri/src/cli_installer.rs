use serde::Serialize;
use std::path::{Path, PathBuf};

const CLI_DESTINATION: &str = "/usr/local/bin/openusage";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    available: bool,
    state: &'static str,
    destination: &'static str,
    message: Option<String>,
}

#[tauri::command]
pub fn get_cli_install_status() -> CliInstallStatus {
    current_status()
}

#[tauri::command]
pub async fn set_cli_installed(installed: bool) -> Result<CliInstallStatus, String> {
    let result = tauri::async_runtime::spawn_blocking(move || set_installed_blocking(installed))
        .await
        .map_err(|error| {
            log::error!("CLI installer task failed: {error}");
            "无法更新命令行工具，请重试。".to_string()
        })?;
    if let Err(error) = result {
        log::error!("failed to update global openusage command: {error}");
        return Err(error);
    }
    Ok(current_status())
}

fn set_installed_blocking(installed: bool) -> Result<(), String> {
    let source = bundled_executable().ok_or_else(|| {
        "当前构建不包含可安装的命令行工具，请使用正式版 OpenUsageCN。".to_string()
    })?;
    if !is_stable_install_source(&source) {
        return Err(
            "请先将 OpenUsageCN 移出安装镜像并放到稳定位置，再安装命令行工具。".to_string(),
        );
    }
    let destination = Path::new(CLI_DESTINATION);
    let status = status_for_paths(&source, destination);
    if installed {
        match status {
            "installed" => return Ok(()),
            "conflict" => {
                return Err(format!(
                    "{} 已存在且不是由 OpenUsageCN 安装，未做覆盖。",
                    CLI_DESTINATION
                ));
            }
            _ => {}
        }
    } else if status != "installed" {
        return Ok(());
    }

    let source = source.to_string_lossy().to_string();
    let directory = destination
        .parent()
        .unwrap_or_else(|| Path::new("/usr/local/bin"));
    let command = if installed {
        format!(
            "if [ -e {destination} ] || [ -L {destination} ]; then exit 73; fi; /bin/mkdir -p {directory} && /bin/ln -s {source} {destination}",
            destination = shell_quote(CLI_DESTINATION),
            directory = shell_quote(&directory.to_string_lossy()),
            source = shell_quote(&source),
        )
    } else {
        format!(
            "target=$(/usr/bin/readlink {destination}) || exit 74; [ \"$target\" = {expected_target} ] || exit 75; /bin/rm {destination}",
            destination = shell_quote(CLI_DESTINATION),
            expected_target = shell_quote(&source),
        )
    };
    run_privileged(&command).map_err(|error| {
        log::error!(
            "failed to {} global openusage command: {}",
            if installed { "install" } else { "remove" },
            error
        );
        if error.contains("-128") || error.to_ascii_lowercase().contains("cancel") {
            "操作已取消。".to_string()
        } else {
            format!(
                "无法{}命令行工具：{}",
                if installed { "安装" } else { "移除" },
                error
            )
        }
    })
}

fn current_status() -> CliInstallStatus {
    let Some(source) = bundled_executable() else {
        return CliInstallStatus {
            available: false,
            state: "unavailable",
            destination: CLI_DESTINATION,
            message: Some("正式版应用安装后可启用全局 openusage 命令。".to_string()),
        };
    };
    if !is_stable_install_source(&source) {
        return CliInstallStatus {
            available: false,
            state: "unavailable",
            destination: CLI_DESTINATION,
            message: Some(
                "请先将 OpenUsageCN 移出安装镜像并放到稳定位置，再安装命令行工具。".to_string(),
            ),
        };
    }
    let state = status_for_paths(&source, Path::new(CLI_DESTINATION));
    CliInstallStatus {
        available: true,
        state,
        destination: CLI_DESTINATION,
        message: if state == "conflict" {
            Some(format!(
                "{} 已存在且不是由 OpenUsageCN 安装。",
                CLI_DESTINATION
            ))
        } else {
            None
        },
    }
}

fn bundled_executable() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let parent = executable.parent()?;
    let contents = parent.parent()?;
    if parent.file_name().and_then(|name| name.to_str()) != Some("MacOS")
        || contents.file_name().and_then(|name| name.to_str()) != Some("Contents")
        || !executable.is_file()
    {
        return None;
    }
    Some(executable)
}

fn status_for_paths(source: &Path, destination: &Path) -> &'static str {
    match std::fs::read_link(destination) {
        Ok(target) if target == source => "installed",
        Ok(_) => "conflict",
        Err(_) if destination.exists() => "conflict",
        Err(_) => "notInstalled",
    }
}

fn is_stable_install_source(source: &Path) -> bool {
    !source.starts_with("/Volumes") && !source.to_string_lossy().contains("/AppTranslocation/")
}

fn run_privileged(command: &str) -> Result<(), String> {
    let script = format!(
        "do shell script {} with administrator privileges",
        apple_script_string(command)
    );
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("authorization exited with {}", output.status)
    } else {
        stderr
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("openusage-cli-installer-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn status_only_accepts_exact_managed_symlink() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("openusagecn");
        let destination = dir.join("openusage");
        std::fs::write(&source, "binary").unwrap();
        assert_eq!(status_for_paths(&source, &destination), "notInstalled");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, &destination).unwrap();
            assert_eq!(status_for_paths(&source, &destination), "installed");
            std::fs::remove_file(&destination).unwrap();
            std::os::unix::fs::symlink(dir.join("foreign"), &destination).unwrap();
            assert_eq!(status_for_paths(&source, &destination), "conflict");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quotes_shell_and_apple_script_values() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(apple_script_string("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn rejects_transient_install_sources() {
        assert!(!is_stable_install_source(Path::new(
            "/Volumes/OpenUsageCN/OpenUsageCN.app/Contents/MacOS/openusagecn"
        )));
        assert!(!is_stable_install_source(Path::new(
            "/private/var/folders/x/AppTranslocation/y/OpenUsageCN.app/Contents/MacOS/openusagecn"
        )));
        assert!(is_stable_install_source(Path::new(
            "/Applications/OpenUsageCN.app/Contents/MacOS/openusagecn"
        )));
    }

    #[test]
    fn treats_a_missing_bundle_target_as_a_conflict() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("Current.app/Contents/MacOS/openusagecn");
        let old_target = dir.join("Old.app/Contents/MacOS/openusagecn");
        let destination = dir.join("openusage");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "binary").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&old_target, &destination).unwrap();
            assert_eq!(status_for_paths(&source, &destination), "conflict");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
