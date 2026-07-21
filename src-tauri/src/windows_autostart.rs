#[cfg(any(target_os = "windows", test))]
use std::ffi::OsString;
#[cfg(any(target_os = "windows", test))]
use std::path::Path;

#[cfg(any(target_os = "windows", test))]
const AUTOSTART_ARGUMENT: &str = "--autostart";

#[cfg(any(target_os = "windows", test))]
fn command_for_executable(executable: &Path) -> OsString {
    let mut command = OsString::from("\"");
    command.push(executable.as_os_str());
    command.push(format!("\" {AUTOSTART_ARGUMENT}"));
    command
}

#[cfg(target_os = "windows")]
fn write_quoted_run_command(app_name: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW};

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("failed to locate the current executable: {error}"))?;
    let subkey = wide_null(OsStr::new(RUN_KEY));
    let value_name = wide_null(OsStr::new(app_name));
    let command = wide_null(&command_for_executable(&executable));
    let byte_count = command
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "autostart command is too long for the Windows registry".to_string())?;

    let status = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            REG_SZ,
            command.as_ptr().cast(),
            byte_count,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "failed to write the Windows startup registry value: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ))
    }
}

#[tauri::command]
pub fn repair_windows_autostart_command(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = write_quoted_run_command(&app_handle.package_info().name) {
            log::error!("Failed to repair the Windows autostart command: {error}");
            return Err(
                "Could not configure Start On Login. Try turning it off and on again.".to_string(),
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_executable_paths_before_the_autostart_argument() {
        let command = command_for_executable(Path::new(
            r"C:\Users\Test User\AppData\Local\OpenUsageCN\OpenUsageCN.exe",
        ));

        assert_eq!(
            command,
            OsString::from(
                r#""C:\Users\Test User\AppData\Local\OpenUsageCN\OpenUsageCN.exe" --autostart"#
            )
        );
    }
}
