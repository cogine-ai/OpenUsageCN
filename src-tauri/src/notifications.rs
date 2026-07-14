#[cfg(target_os = "macos")]
mod macos {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{AnyThread, define_class, msg_send};
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::{OnceLock, mpsc};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
    const THREAD_IDENTIFIER: &str = "openusagecn.pace";

    fn app_handle_slot() -> &'static OnceLock<AppHandle> {
        static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
        &APP_HANDLE
    }

    fn notification_center_available() -> bool {
        std::env::current_exe()
            .ok()
            .as_deref()
            .is_some_and(is_bundled_app_executable)
    }

    fn is_bundled_app_executable(executable: &std::path::Path) -> bool {
        let Some(macos_dir) = executable.parent() else {
            return false;
        };
        let Some(contents_dir) = macos_dir.parent() else {
            return false;
        };
        let Some(app_dir) = contents_dir.parent() else {
            return false;
        };
        macos_dir.file_name().and_then(|name| name.to_str()) == Some("MacOS")
            && contents_dir.file_name().and_then(|name| name.to_str()) == Some("Contents")
            && app_dir.extension().and_then(|extension| extension.to_str()) == Some("app")
    }

    fn ensure_notification_center_available() -> Result<(), String> {
        if notification_center_available() {
            Ok(())
        } else {
            Err("当前调试构建不支持系统通知，请使用 .app 构建。".to_string())
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "OpenUsageCNPaceNotificationDelegate"]
        #[ivars = ()]
        struct PaceNotificationDelegate;

        unsafe impl NSObjectProtocol for PaceNotificationDelegate {}

        #[allow(non_snake_case)]
        unsafe impl UNUserNotificationCenterDelegate for PaceNotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn userNotificationCenter_willPresentNotification_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                _response: &UNNotificationResponse,
                completion_handler: &DynBlock<dyn Fn()>,
            ) {
                if let Some(app_handle) = app_handle_slot().get() {
                    let dispatcher = app_handle.clone();
                    let task_handle = app_handle.clone();
                    if let Err(error) = dispatcher.run_on_main_thread(move || {
                        crate::panel::show_panel(&task_handle);
                        if let Err(error) = task_handle.emit("tray:navigate", "home") {
                            log::error!(
                                "failed to navigate after pace notification click: {error}"
                            );
                        }
                    }) {
                        log::error!("failed to handle pace notification click: {error}");
                    }
                }
                completion_handler.call(());
            }
        }
    );

    impl PaceNotificationDelegate {
        fn new() -> Retained<Self> {
            let allocated = Self::alloc().set_ivars(());
            unsafe { msg_send![super(allocated), init] }
        }
    }

    pub fn register_delegate(app_handle: AppHandle) {
        if !notification_center_available() {
            log::warn!("pace notifications are unavailable outside a macOS app bundle");
            return;
        }
        if app_handle_slot().set(app_handle).is_err() {
            log::warn!("pace notification delegate was already registered");
            return;
        }
        let delegate = PaceNotificationDelegate::new();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // UNUserNotificationCenter.delegate is weak; retain for app lifetime.
        std::mem::forget(delegate);
    }

    pub fn permission() -> Result<String, String> {
        if !notification_center_available() {
            return Ok("unavailable".to_string());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (sender, receiver) = mpsc::channel();
        let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = sender.send(permission_label(status));
        });
        center.getNotificationSettingsWithCompletionHandler(&completion);
        receiver.recv_timeout(CALLBACK_TIMEOUT).map_err(|error| {
            log::error!("timed out reading notification permission: {error}");
            "无法读取系统通知权限。".to_string()
        })
    }

    pub fn request_permission() -> Result<String, String> {
        if !notification_center_available() {
            return Ok("unavailable".to_string());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (sender, receiver) = mpsc::channel();
        let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let result = if !error.is_null() {
                Err(unsafe { &*error }.localizedDescription().to_string())
            } else if granted.as_bool() {
                Ok("granted".to_string())
            } else {
                Ok("denied".to_string())
            };
            let _ = sender.send(result);
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
        // The system sheet is user-driven and has no meaningful timeout. The
        // callback completes after the user decides, and the returned status
        // is then reflected by the Settings UI.
        receiver.recv().map_err(|error| {
            log::error!("notification permission callback disconnected: {error}");
            "无法读取系统通知权限结果。".to_string()
        })?
    }

    pub fn post(title: String, subtitle: String, body: String) -> Result<(), String> {
        ensure_notification_center_available()?;
        let permission = permission()?;
        if permission != "granted" {
            return Err("系统通知权限尚未开启。".to_string());
        }

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setSubtitle(&NSString::from_str(&subtitle));
        content.setBody(&NSString::from_str(&body));
        content.setThreadIdentifier(&NSString::from_str(THREAD_IDENTIFIER));
        let sound = UNNotificationSound::defaultSound();
        content.setSound(Some(&sound));
        let identifier = NSString::from_str(&format!("openusagecn-pace-{}", uuid::Uuid::new_v4()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (sender, receiver) = mpsc::channel();
        let completion = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err(unsafe { &*error }.localizedDescription().to_string())
            };
            let _ = sender.send(result);
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        receiver.recv_timeout(CALLBACK_TIMEOUT).map_err(|error| {
            log::error!("timed out posting pace notification: {error}");
            "系统通知投递超时。".to_string()
        })?
    }

    pub fn open_settings() -> Result<(), String> {
        let status = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("系统设置打开失败：{status}"))
        }
    }

    fn permission_label(status: UNAuthorizationStatus) -> String {
        if matches!(
            status,
            UNAuthorizationStatus::Authorized
                | UNAuthorizationStatus::Provisional
                | UNAuthorizationStatus::Ephemeral
        ) {
            "granted"
        } else if status == UNAuthorizationStatus::Denied {
            "denied"
        } else {
            "default"
        }
        .to_string()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn recognizes_only_executables_inside_a_macos_app_bundle() {
            assert!(is_bundled_app_executable(std::path::Path::new(
                "/Applications/OpenUsageCN.app/Contents/MacOS/openusagecn"
            )));
            assert!(!is_bundled_app_executable(std::path::Path::new(
                "/workspace/src-tauri/target/debug/openusagecn"
            )));
            assert!(!is_bundled_app_executable(std::path::Path::new(
                "/workspace/OpenUsageCN/Contents/MacOS/openusagecn"
            )));
        }

        #[test]
        fn reports_notification_permission_as_unavailable_outside_an_app_bundle() {
            assert_eq!(permission().unwrap(), "unavailable");
        }
    }
}

#[tauri::command]
pub async fn get_notification_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let result = tauri::async_runtime::spawn_blocking(macos::permission)
            .await
            .map_err(|error| {
                log::error!("notification permission task failed: {error}");
                "无法读取系统通知权限。".to_string()
            })?;
        if let Err(error) = &result {
            log::error!("failed to read notification permission: {error}");
        }
        return result;
    }
    #[cfg(not(target_os = "macos"))]
    Err("当前平台暂不支持额度节奏通知。".to_string())
}

#[tauri::command]
pub async fn request_notification_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let result = tauri::async_runtime::spawn_blocking(macos::request_permission)
            .await
            .map_err(|error| {
                log::error!("notification authorization task failed: {error}");
                "无法请求系统通知权限。".to_string()
            })?;
        if let Err(error) = &result {
            log::error!("failed to request notification permission: {error}");
        }
        return result;
    }
    #[cfg(not(target_os = "macos"))]
    Err("当前平台暂不支持额度节奏通知。".to_string())
}

#[tauri::command]
pub async fn post_pace_notification(
    title: String,
    subtitle: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let result =
            tauri::async_runtime::spawn_blocking(move || macos::post(title, subtitle, body))
                .await
                .map_err(|error| {
                    log::error!("pace notification task failed: {error}");
                    "系统通知投递失败。".to_string()
                })?;
        if let Err(error) = &result {
            log::error!("failed to post pace notification: {error}");
        }
        return result;
    }
    #[cfg(not(target_os = "macos"))]
    Err("当前平台暂不支持额度节奏通知。".to_string())
}

#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let result = tauri::async_runtime::spawn_blocking(macos::open_settings)
            .await
            .map_err(|error| {
                log::error!("notification settings task failed: {error}");
                "无法打开系统通知设置。".to_string()
            })?;
        if let Err(error) = &result {
            log::error!("failed to open notification settings: {error}");
        }
        return result;
    }
    #[cfg(not(target_os = "macos"))]
    Err("当前平台暂不支持额度节奏通知。".to_string())
}

#[cfg(target_os = "macos")]
pub use macos::register_delegate;
