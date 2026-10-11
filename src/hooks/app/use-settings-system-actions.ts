import { useCallback } from "react"
import { applyGlobalShortcut } from "@/lib/global-shortcut"
import {
  getEnabledPluginIds,
  saveAutoUpdateInterval,
  savePaceNotificationSettings,
  saveStartOnLogin,
  type AutoUpdateIntervalMinutes,
  type GlobalShortcut,
  type PaceNotificationSettings,
  type PluginSettings,
} from "@/lib/settings"

type UseSettingsSystemActionsArgs = {
  pluginSettings: PluginSettings | null
  setAutoUpdateInterval: (value: AutoUpdateIntervalMinutes) => void
  setAutoUpdateNextAt: (value: number | null) => void
  setGlobalShortcut: (value: GlobalShortcut) => void
  setStartOnLogin: (value: boolean) => void
  applyStartOnLogin: (value: boolean) => Promise<void>
  paceNotifications: PaceNotificationSettings
  setPaceNotifications: (value: PaceNotificationSettings) => void
}

export function useSettingsSystemActions({
  pluginSettings,
  setAutoUpdateInterval,
  setAutoUpdateNextAt,
  setGlobalShortcut,
  setStartOnLogin,
  applyStartOnLogin,
  paceNotifications,
  setPaceNotifications,
}: UseSettingsSystemActionsArgs) {
  const handleAutoUpdateIntervalChange = useCallback((value: AutoUpdateIntervalMinutes) => {
    setAutoUpdateInterval(value)

    if (pluginSettings) {
      const enabledIds = getEnabledPluginIds(pluginSettings)
      if (enabledIds.length > 0) {
        setAutoUpdateNextAt(Date.now() + value * 60_000)
      } else {
        setAutoUpdateNextAt(null)
      }
    }

    void saveAutoUpdateInterval(value).catch((error) => {
      console.error("Failed to save auto-update interval:", error)
    })
  }, [pluginSettings, setAutoUpdateInterval, setAutoUpdateNextAt])

  const handleGlobalShortcutChange = useCallback(async (value: GlobalShortcut) => {
    try {
      const status = await applyGlobalShortcut(value)
      setGlobalShortcut(status.shortcut)
    } catch (error) {
      console.error("Failed to update global shortcut:", error)
      throw error
    }
  }, [setGlobalShortcut])

  const handleStartOnLoginChange = useCallback((value: boolean) => {
    setStartOnLogin(value)
    void saveStartOnLogin(value).catch((error) => {
      console.error("Failed to save start on login:", error)
    })
    void applyStartOnLogin(value).catch((error) => {
      console.error("Failed to update start on login:", error)
    })
  }, [applyStartOnLogin, setStartOnLogin])

  const handlePaceNotificationsChange = useCallback(async (value: PaceNotificationSettings) => {
    setPaceNotifications(value)
    try {
      await savePaceNotificationSettings(value)
    } catch (error) {
      console.error("Failed to save pace notification settings:", error)
      setPaceNotifications(paceNotifications)
      throw error
    }
  }, [paceNotifications, setPaceNotifications])

  return {
    handleAutoUpdateIntervalChange,
    handleGlobalShortcutChange,
    handleStartOnLoginChange,
    handlePaceNotificationsChange,
  }
}
