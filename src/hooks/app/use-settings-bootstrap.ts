import { useCallback, useEffect } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PlatformCapabilities } from "@/lib/platform-capabilities"
import {
  arePluginSettingsEqual,
  DEFAULT_AUTO_UPDATE_INTERVAL,
  DEFAULT_DISPLAY_MODE,
  DEFAULT_GLOBAL_SHORTCUT,
  DEFAULT_MENUBAR_ICON_STYLE,
  DEFAULT_MENUBAR_METRIC,
  DEFAULT_PACE_NOTIFICATION_SETTINGS,
  DEFAULT_RESET_TIMER_DISPLAY_MODE,
  DEFAULT_START_ON_LOGIN,
  DEFAULT_THEME_MODE,
  DEFAULT_TIME_FORMAT_MODE,
  getEnabledPluginIds,
  loadAutoUpdateInterval,
  loadDisplayMode,
  loadGlobalShortcut,
  loadMenubarIconStyle,
  loadMenubarMetric,
  loadPaceNotificationSettings,
  migrateLegacyTraySettings,
  migrateWindsurfToDevin,
  loadPluginSettings,
  loadResetTimerDisplayMode,
  loadStartOnLogin,
  loadThemeMode,
  loadTimeFormatMode,
  normalizePluginSettings,
  savePluginSettings,
  type AutoUpdateIntervalMinutes,
  type DisplayMode,
  type GlobalShortcut,
  type MenubarIconStyle,
  type MenubarMetric,
  type PaceNotificationSettings,
  type PluginSettings,
  type ResetTimerDisplayMode,
  type ThemeMode,
  type TimeFormatMode,
} from "@/lib/settings"

type UseSettingsBootstrapArgs = {
  platformCapabilities: PlatformCapabilities | null
  setPluginSettings: (value: PluginSettings | null) => void
  setPluginsMeta: (value: PluginMeta[]) => void
  setAutoUpdateInterval: (value: AutoUpdateIntervalMinutes) => void
  setThemeMode: (value: ThemeMode) => void
  setDisplayMode: (value: DisplayMode) => void
  setResetTimerDisplayMode: (value: ResetTimerDisplayMode) => void
  setTimeFormatMode: (value: TimeFormatMode) => void
  setGlobalShortcut: (value: GlobalShortcut) => void
  setStartOnLogin: (value: boolean) => void
  setMenubarIconStyle: (value: MenubarIconStyle) => void
  setMenubarMetric: (value: MenubarMetric) => void
  setPaceNotifications: (value: PaceNotificationSettings) => void
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  startBatch: (pluginIds?: string[]) => Promise<string[] | undefined>
}

export function useSettingsBootstrap({
  platformCapabilities,
  setPluginSettings,
  setPluginsMeta,
  setAutoUpdateInterval,
  setThemeMode,
  setDisplayMode,
  setResetTimerDisplayMode,
  setTimeFormatMode,
  setGlobalShortcut,
  setStartOnLogin,
  setMenubarIconStyle,
  setMenubarMetric,
  setPaceNotifications,
  setLoadingForPlugins,
  setErrorForPlugins,
  startBatch,
}: UseSettingsBootstrapArgs) {
  const applyStartOnLogin = useCallback(
    async (value: boolean) => {
      if (!isTauri()) return
      const currentlyEnabled = await isAutostartEnabled()

      if (currentlyEnabled !== value) {
        if (value) {
          await enableAutostart()
        } else {
          await disableAutostart()
        }
      }

      if (value && platformCapabilities?.platform === "windows") {
        await invoke("repair_windows_autostart_command")
      }
    },
    [platformCapabilities?.platform]
  )

  useEffect(() => {
    let isMounted = true

    const loadSettings = async () => {
      try {
        const availablePlugins = await invoke<PluginMeta[]>("list_plugins")
        if (!isMounted) return
        setPluginsMeta(availablePlugins)

        const storedSettings = await loadPluginSettings()
        const migratedSettings = migrateWindsurfToDevin(storedSettings)
        const normalized = normalizePluginSettings(migratedSettings, availablePlugins)
        if (!arePluginSettingsEqual(storedSettings, normalized)) {
          await savePluginSettings(normalized)
        }

        let storedInterval = DEFAULT_AUTO_UPDATE_INTERVAL
        try {
          storedInterval = await loadAutoUpdateInterval()
        } catch (error) {
          console.error("Failed to load auto-update interval:", error)
        }

        let storedThemeMode = DEFAULT_THEME_MODE
        try {
          storedThemeMode = await loadThemeMode()
        } catch (error) {
          console.error("Failed to load theme mode:", error)
        }

        let storedDisplayMode = DEFAULT_DISPLAY_MODE
        try {
          storedDisplayMode = await loadDisplayMode()
        } catch (error) {
          console.error("Failed to load display mode:", error)
        }

        let storedResetTimerDisplayMode = DEFAULT_RESET_TIMER_DISPLAY_MODE
        try {
          storedResetTimerDisplayMode = await loadResetTimerDisplayMode()
        } catch (error) {
          console.error("Failed to load reset timer display mode:", error)
        }

        let storedTimeFormatMode = DEFAULT_TIME_FORMAT_MODE
        try {
          storedTimeFormatMode = await loadTimeFormatMode()
        } catch (error) {
          console.error("Failed to load time format mode:", error)
        }

        if (isMounted) {
          setPluginSettings(normalized)
          setAutoUpdateInterval(storedInterval)
          setThemeMode(storedThemeMode)
          setDisplayMode(storedDisplayMode)
          setResetTimerDisplayMode(storedResetTimerDisplayMode)
          setTimeFormatMode(storedTimeFormatMode)
          const enabledIds = getEnabledPluginIds(normalized)
          setLoadingForPlugins(enabledIds)
          try {
            await startBatch(enabledIds)
          } catch (error) {
            console.error("Failed to start probe batch:", error)
            if (isMounted) {
              setErrorForPlugins(enabledIds, "无法开始刷新")
            }
          }
        }
      } catch (e) {
        console.error("Failed to load plugin settings:", e)
      }
    }

    loadSettings()

    return () => {
      isMounted = false
    }
  }, [
    setAutoUpdateInterval,
    setDisplayMode,
    setErrorForPlugins,
    setLoadingForPlugins,
    migrateWindsurfToDevin,
    setPluginSettings,
    setPluginsMeta,
    setResetTimerDisplayMode,
    setThemeMode,
    setTimeFormatMode,
    startBatch,
  ])

  useEffect(() => {
    if (!platformCapabilities) return
    let isMounted = true

    const loadPlatformSettings = async () => {
      if (platformCapabilities.globalShortcuts) {
        let storedGlobalShortcut = DEFAULT_GLOBAL_SHORTCUT
        try {
          storedGlobalShortcut = await loadGlobalShortcut()
        } catch (error) {
          console.error("Failed to load global shortcut:", error)
        }
        if (isMounted) setGlobalShortcut(storedGlobalShortcut)
      }

      if (platformCapabilities.autostart) {
        let storedStartOnLogin = DEFAULT_START_ON_LOGIN
        try {
          storedStartOnLogin = await loadStartOnLogin()
        } catch (error) {
          console.error("Failed to load start on login:", error)
        }
        if (isMounted) setStartOnLogin(storedStartOnLogin)
        try {
          await applyStartOnLogin(storedStartOnLogin)
        } catch (error) {
          console.error("Failed to apply start on login setting:", error)
        }
      }

      if (platformCapabilities.dynamicTrayIconSettings) {
        try {
          await migrateLegacyTraySettings()
        } catch (error) {
          console.error("Failed to migrate legacy tray settings:", error)
        }

        let storedMenubarIconStyle = DEFAULT_MENUBAR_ICON_STYLE
        try {
          storedMenubarIconStyle = await loadMenubarIconStyle()
        } catch (error) {
          console.error("Failed to load menubar icon style:", error)
        }
        if (isMounted) setMenubarIconStyle(storedMenubarIconStyle)

        let storedMenubarMetric = DEFAULT_MENUBAR_METRIC
        try {
          storedMenubarMetric = await loadMenubarMetric()
        } catch (error) {
          console.error("Failed to load menubar metric:", error)
        }
        if (isMounted) setMenubarMetric(storedMenubarMetric)
      }

      if (platformCapabilities.paceNotifications) {
        let storedPaceNotifications = DEFAULT_PACE_NOTIFICATION_SETTINGS
        try {
          storedPaceNotifications = await loadPaceNotificationSettings()
        } catch (error) {
          console.error("Failed to load pace notification settings:", error)
        }
        if (isMounted) setPaceNotifications(storedPaceNotifications)
      }
    }

    void loadPlatformSettings()

    return () => {
      isMounted = false
    }
  }, [
    applyStartOnLogin,
    platformCapabilities,
    setGlobalShortcut,
    setMenubarIconStyle,
    setMenubarMetric,
    setPaceNotifications,
    setStartOnLogin,
  ])

  return {
    applyStartOnLogin,
  }
}
