use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub platform: &'static str,
    pub cli: bool,
    pub pace_notifications: bool,
    pub global_shortcuts: bool,
    pub native_tray_title: bool,
    pub dynamic_tray_icon_settings: bool,
}

fn capabilities_for_platform(platform: &'static str) -> PlatformCapabilities {
    let macos = platform == "macos";
    PlatformCapabilities {
        platform,
        cli: macos,
        pace_notifications: macos,
        global_shortcuts: macos,
        native_tray_title: macos,
        dynamic_tray_icon_settings: macos,
    }
}

#[tauri::command]
pub fn get_platform_capabilities() -> PlatformCapabilities {
    capabilities_for_platform(std::env::consts::OS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_keeps_api_and_autostart_only() {
        let capabilities = capabilities_for_platform("windows");
        assert!(!capabilities.cli);
        assert!(!capabilities.pace_notifications);
        assert!(!capabilities.global_shortcuts);
        assert!(!capabilities.native_tray_title);
        assert!(!capabilities.dynamic_tray_icon_settings);
    }

    #[test]
    fn macos_preserves_current_features() {
        let capabilities = capabilities_for_platform("macos");
        assert!(capabilities.cli);
        assert!(capabilities.pace_notifications);
        assert!(capabilities.global_shortcuts);
        assert!(capabilities.native_tray_title);
        assert!(capabilities.dynamic_tray_icon_settings);
    }
}
