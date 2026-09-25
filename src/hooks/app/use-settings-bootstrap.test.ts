import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  arePluginSettingsEqualMock,
  disableAutostartMock,
  enableDetectedPluginsMock,
  enableAutostartMock,
  getEnabledPluginIdsMock,
  getNewPluginIdsMock,
  invokeMock,
  isAutostartEnabledMock,
  isTauriMock,
  loadAutoUpdateIntervalMock,
  loadDisplayModeMock,
  loadGlobalShortcutMock,
  loadMenubarIconStyleMock,
  loadMenubarMetricMock,
  loadPaceNotificationSettingsMock,
  loadPluginSettingsMock,
  loadResetTimerDisplayModeMock,
  loadStartOnLoginMock,
  loadThemeModeMock,
  loadTimeFormatModeMock,
  migrateLegacyTraySettingsMock,
  migrateWindsurfToDevinMock,
  normalizePluginSettingsMock,
  savePluginSettingsMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
  isAutostartEnabledMock: vi.fn(),
  enableAutostartMock: vi.fn(),
  disableAutostartMock: vi.fn(),
  enableDetectedPluginsMock: vi.fn(),
  arePluginSettingsEqualMock: vi.fn(),
  getEnabledPluginIdsMock: vi.fn(),
  getNewPluginIdsMock: vi.fn(),
  loadAutoUpdateIntervalMock: vi.fn(),
  loadDisplayModeMock: vi.fn(),
  loadGlobalShortcutMock: vi.fn(),
  loadMenubarIconStyleMock: vi.fn(),
  loadMenubarMetricMock: vi.fn(),
  loadPaceNotificationSettingsMock: vi.fn(),
  loadPluginSettingsMock: vi.fn(),
  loadResetTimerDisplayModeMock: vi.fn(),
  loadStartOnLoginMock: vi.fn(),
  loadThemeModeMock: vi.fn(),
  loadTimeFormatModeMock: vi.fn(),
  migrateLegacyTraySettingsMock: vi.fn(),
  migrateWindsurfToDevinMock: vi.fn(),
  normalizePluginSettingsMock: vi.fn(),
  savePluginSettingsMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

vi.mock("@tauri-apps/plugin-autostart", () => ({
  disable: disableAutostartMock,
  enable: enableAutostartMock,
  isEnabled: isAutostartEnabledMock,
}))

vi.mock("@/lib/settings", () => ({
  arePluginSettingsEqual: arePluginSettingsEqualMock,
  DEFAULT_AUTO_UPDATE_INTERVAL: 15,
  DEFAULT_DISPLAY_MODE: "left",
  DEFAULT_GLOBAL_SHORTCUT: null,
  DEFAULT_MENUBAR_ICON_STYLE: "provider",
  DEFAULT_MENUBAR_METRIC: "default",
  DEFAULT_PACE_NOTIFICATION_SETTINGS: {
    almostOut: false,
    closeToLimit: false,
    runningOut: false,
  },
  DEFAULT_RESET_TIMER_DISPLAY_MODE: "relative",
  DEFAULT_START_ON_LOGIN: false,
  DEFAULT_THEME_MODE: "system",
  DEFAULT_TIME_FORMAT_MODE: "auto",
  enableDetectedPlugins: enableDetectedPluginsMock,
  getEnabledPluginIds: getEnabledPluginIdsMock,
  getNewPluginIds: getNewPluginIdsMock,
  loadAutoUpdateInterval: loadAutoUpdateIntervalMock,
  loadDisplayMode: loadDisplayModeMock,
  loadGlobalShortcut: loadGlobalShortcutMock,
  loadMenubarIconStyle: loadMenubarIconStyleMock,
  loadMenubarMetric: loadMenubarMetricMock,
  loadPaceNotificationSettings: loadPaceNotificationSettingsMock,
  loadPluginSettings: loadPluginSettingsMock,
  loadResetTimerDisplayMode: loadResetTimerDisplayModeMock,
  loadStartOnLogin: loadStartOnLoginMock,
  loadThemeMode: loadThemeModeMock,
  loadTimeFormatMode: loadTimeFormatModeMock,
  migrateLegacyTraySettings: migrateLegacyTraySettingsMock,
  migrateWindsurfToDevin: migrateWindsurfToDevinMock,
  normalizePluginSettings: normalizePluginSettingsMock,
  savePluginSettings: savePluginSettingsMock,
}))

import { useSettingsBootstrap } from "@/hooks/app/use-settings-bootstrap"

const macosCapabilities = {
  platform: "macos",
  localHttpApi: true,
  autostart: true,
  cli: true,
  paceNotifications: true,
  globalShortcuts: true,
  nativeTrayTitle: true,
  dynamicTrayIconSettings: true,
}

const windowsCapabilities = {
  platform: "windows",
  localHttpApi: true,
  autostart: true,
  cli: false,
  paceNotifications: false,
  globalShortcuts: false,
  nativeTrayTitle: false,
  dynamicTrayIconSettings: false,
}

function createArgs() {
  return {
    platformCapabilities: macosCapabilities,
    setPluginSettings: vi.fn(),
    setPluginsMeta: vi.fn(),
    setAutoUpdateInterval: vi.fn(),
    setThemeMode: vi.fn(),
    setDisplayMode: vi.fn(),
    setResetTimerDisplayMode: vi.fn(),
    setTimeFormatMode: vi.fn(),
    setGlobalShortcut: vi.fn(),
    setStartOnLogin: vi.fn(),
    setMenubarIconStyle: vi.fn(),
    setMenubarMetric: vi.fn(),
    setPaceNotifications: vi.fn(),
    setLoadingForPlugins: vi.fn(),
    setErrorForPlugins: vi.fn(),
    startBatch: vi.fn().mockResolvedValue(undefined),
  }
}

describe("useSettingsBootstrap", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isAutostartEnabledMock.mockReset()
    enableAutostartMock.mockReset()
    disableAutostartMock.mockReset()
    enableDetectedPluginsMock.mockReset()
    arePluginSettingsEqualMock.mockReset()
    getEnabledPluginIdsMock.mockReset()
    getNewPluginIdsMock.mockReset()
    loadAutoUpdateIntervalMock.mockReset()
    loadDisplayModeMock.mockReset()
    loadGlobalShortcutMock.mockReset()
    loadMenubarIconStyleMock.mockReset()
    loadMenubarMetricMock.mockReset()
    loadPaceNotificationSettingsMock.mockReset()
    loadPluginSettingsMock.mockReset()
    loadResetTimerDisplayModeMock.mockReset()
    loadStartOnLoginMock.mockReset()
    loadThemeModeMock.mockReset()
    loadTimeFormatModeMock.mockReset()
    migrateLegacyTraySettingsMock.mockReset()
    migrateWindsurfToDevinMock.mockReset()
    normalizePluginSettingsMock.mockReset()
    savePluginSettingsMock.mockReset()

    isTauriMock.mockReturnValue(true)
    isAutostartEnabledMock.mockResolvedValue(true)
    invokeMock.mockResolvedValue([
      {
        id: "codex",
        name: "Codex",
        iconUrl: "/codex.svg",
        brandColor: "#000000",
        lines: [],
        primaryCandidates: [],
      },
    ])
    loadPluginSettingsMock.mockResolvedValue({ order: ["codex"], disabled: [] })
    normalizePluginSettingsMock.mockImplementation((stored) => stored)
    arePluginSettingsEqualMock.mockReturnValue(true)
    loadAutoUpdateIntervalMock.mockResolvedValue(15)
    loadThemeModeMock.mockResolvedValue("dark")
    loadDisplayModeMock.mockResolvedValue("used")
    loadResetTimerDisplayModeMock.mockResolvedValue("relative")
    loadTimeFormatModeMock.mockResolvedValue("auto")
    loadGlobalShortcutMock.mockResolvedValue("CommandOrControl+Shift+O")
    loadMenubarIconStyleMock.mockResolvedValue("provider")
    loadMenubarMetricMock.mockResolvedValue("default")
    loadPaceNotificationSettingsMock.mockResolvedValue({
      almostOut: false,
      closeToLimit: false,
      runningOut: false,
    })
    loadStartOnLoginMock.mockResolvedValue(true)
    migrateLegacyTraySettingsMock.mockResolvedValue(undefined)
    migrateWindsurfToDevinMock.mockImplementation((settings) => settings)
    getNewPluginIdsMock.mockImplementation((settings, plugins) =>
      plugins.map((plugin) => plugin.id).filter((id) =>
        ["deepseek", "moonshot", "ollama", "doubao", "xai"].includes(id) &&
        !settings.order.includes(id) && !settings.disabled.includes(id)))
    enableDetectedPluginsMock.mockImplementation((settings, candidates, detected) => ({
      ...settings,
      disabled: settings.disabled.filter((id) =>
        !candidates.includes(id) || !detected.includes(id)),
    }))
    savePluginSettingsMock.mockResolvedValue(undefined)
    getEnabledPluginIdsMock.mockReturnValue(["codex"])
  })

  it("disables autostart when applyStartOnLogin receives false", async () => {
    const args = createArgs()
    const { result } = renderHook(() => useSettingsBootstrap(args))

    await result.current.applyStartOnLogin(false)

    expect(disableAutostartMock).toHaveBeenCalledTimes(1)
    expect(enableAutostartMock).not.toHaveBeenCalled()
  })

  it("quotes the Windows startup command even when autostart is already enabled", async () => {
    const args = {
      ...createArgs(),
      platformCapabilities: windowsCapabilities,
    }
    const { result } = renderHook(() => useSettingsBootstrap(args))

    await result.current.applyStartOnLogin(true)

    expect(enableAutostartMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith("repair_windows_autostart_command")
  })

  it("falls back to default reset timer mode when loading fails", async () => {
    const resetModeError = new Error("reset timer mode unavailable")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    loadResetTimerDisplayModeMock.mockRejectedValueOnce(resetModeError)
    const args = createArgs()

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to load reset timer display mode:",
        resetModeError
      )
      expect(args.setResetTimerDisplayMode).toHaveBeenCalledWith("relative")
    })

    errorSpy.mockRestore()
  })

  it("applies the stored menubar metric", async () => {
    loadMenubarMetricMock.mockResolvedValueOnce("weekly")
    const args = createArgs()

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(args.setMenubarMetric).toHaveBeenCalledWith("weekly")
    })
  })

  it("falls back to default menubar metric when loading fails", async () => {
    const metricError = new Error("menubar metric unavailable")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    loadMenubarMetricMock.mockRejectedValueOnce(metricError)
    const args = createArgs()

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("Failed to load menubar metric:", metricError)
      expect(args.setMenubarMetric).toHaveBeenCalledWith("default")
    })

    errorSpy.mockRestore()
  })

  it("migrates windsurf settings before normalizing and saves the first-launch result", async () => {
    const args = createArgs()
    const storedSettings = { order: ["windsurf"], disabled: [] }
    const migratedSettings = { order: ["devin"], disabled: [] }
    const availablePlugins = [
      {
        id: "devin",
        name: "Devin",
        iconUrl: "/devin.svg",
        brandColor: "#000000",
        lines: [],
        primaryCandidates: [],
      },
    ]

    invokeMock.mockResolvedValueOnce(availablePlugins)
    loadPluginSettingsMock.mockResolvedValueOnce(storedSettings)
    migrateWindsurfToDevinMock.mockReturnValueOnce(migratedSettings)
    normalizePluginSettingsMock.mockReturnValueOnce(migratedSettings)
    arePluginSettingsEqualMock.mockReturnValueOnce(false)
    getEnabledPluginIdsMock.mockReturnValueOnce(["devin"])

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(normalizePluginSettingsMock).toHaveBeenCalledWith(
        migratedSettings,
        availablePlugins
      )
      expect(savePluginSettingsMock).toHaveBeenCalledWith(migratedSettings)
      expect(args.setPluginSettings).toHaveBeenCalledWith(migratedSettings)
      expect(args.startBatch).toHaveBeenCalledWith(["devin"])
    })
  })

  it("enables a newly shipped provider when local credentials are detected", async () => {
    const args = createArgs()
    const plugins = [
      { id: "codex", name: "Codex", iconUrl: "", lines: [] },
      { id: "deepseek", name: "DeepSeek", iconUrl: "", lines: [] },
    ]
    invokeMock.mockResolvedValueOnce(plugins).mockResolvedValueOnce(["deepseek"])
    normalizePluginSettingsMock.mockReturnValueOnce({
      order: ["codex", "deepseek"], disabled: ["deepseek"],
    })
    arePluginSettingsEqualMock.mockReturnValueOnce(false)
    getEnabledPluginIdsMock.mockImplementation((settings) =>
      settings.order.filter((id) => !settings.disabled.includes(id)))

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("detect_local_provider_credentials", {
        pluginIds: ["deepseek"],
      })
      expect(savePluginSettingsMock).toHaveBeenCalledWith({
        order: ["codex", "deepseek"], disabled: [],
      })
      expect(args.startBatch).toHaveBeenCalledWith(["codex", "deepseek"])
    })
  })

  it("keeps the starter set and adds detected providers on a fresh install", async () => {
    const args = createArgs()
    loadPluginSettingsMock.mockResolvedValueOnce({ order: [], disabled: [] })
    invokeMock.mockResolvedValueOnce([
      { id: "claude", name: "Claude", iconUrl: "", lines: [] },
      { id: "codex", name: "Codex", iconUrl: "", lines: [] },
      { id: "deepseek", name: "DeepSeek", iconUrl: "", lines: [] },
    ]).mockResolvedValueOnce(["deepseek"])
    normalizePluginSettingsMock.mockReturnValueOnce({
      order: ["claude", "codex", "deepseek"], disabled: ["deepseek"],
    })
    arePluginSettingsEqualMock.mockReturnValueOnce(false)
    getEnabledPluginIdsMock.mockImplementation((settings) =>
      settings.order.filter((id) => !settings.disabled.includes(id)))

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("detect_local_provider_credentials", {
        pluginIds: ["deepseek"],
      })
      expect(args.startBatch).toHaveBeenCalledWith(["claude", "codex", "deepseek"])
    })
  })

  it("never re-enables a provider already seen and switched off", async () => {
    const args = createArgs()
    const stored = { order: ["codex", "deepseek"], disabled: ["deepseek"] }
    loadPluginSettingsMock.mockResolvedValueOnce(stored)
    normalizePluginSettingsMock.mockReturnValueOnce(stored)
    invokeMock.mockResolvedValueOnce([
      { id: "codex", name: "Codex", iconUrl: "", lines: [] },
      { id: "deepseek", name: "DeepSeek", iconUrl: "", lines: [] },
    ])

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => expect(args.setPluginSettings).toHaveBeenCalledWith(stored))
    expect(invokeMock).not.toHaveBeenCalledWith("detect_local_provider_credentials", expect.anything())
  })

  it("keeps newly shipped providers unseen when credential detection fails", async () => {
    const args = createArgs()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock.mockResolvedValueOnce([
      { id: "codex", name: "Codex", iconUrl: "", lines: [] },
      { id: "deepseek", name: "DeepSeek", iconUrl: "", lines: [] },
    ]).mockRejectedValueOnce(new Error("IPC unavailable"))
    normalizePluginSettingsMock.mockReturnValueOnce({
      order: ["codex", "deepseek"], disabled: ["deepseek"],
    })

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => expect(args.setPluginSettings).toHaveBeenCalled())
    expect(savePluginSettingsMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to detect local provider credentials:", expect.any(Error))
    errorSpy.mockRestore()
  })

  it("does not load unsupported Windows-only settings behavior", async () => {
    const args = {
      ...createArgs(),
      platformCapabilities: windowsCapabilities,
    }

    renderHook(() => useSettingsBootstrap(args))

    await waitFor(() => {
      expect(args.startBatch).toHaveBeenCalledWith(["codex"])
      expect(args.setStartOnLogin).toHaveBeenCalledWith(true)
    })
    expect(loadGlobalShortcutMock).not.toHaveBeenCalled()
    expect(migrateLegacyTraySettingsMock).not.toHaveBeenCalled()
    expect(loadMenubarIconStyleMock).not.toHaveBeenCalled()
    expect(loadMenubarMetricMock).not.toHaveBeenCalled()
    expect(loadPaceNotificationSettingsMock).not.toHaveBeenCalled()
  })
})
