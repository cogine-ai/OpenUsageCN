import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getEnabledPluginIdsMock,
  invokeMock,
  isTauriMock,
  saveAutoUpdateIntervalMock,
  saveGlobalShortcutMock,
  savePaceNotificationSettingsMock,
  saveStartOnLoginMock,
} = vi.hoisted(() => ({
  getEnabledPluginIdsMock: vi.fn(),
  saveAutoUpdateIntervalMock: vi.fn(),
  saveGlobalShortcutMock: vi.fn(),
  savePaceNotificationSettingsMock: vi.fn(),
  saveStartOnLoginMock: vi.fn(),
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

vi.mock("@/lib/settings", () => ({
  getEnabledPluginIds: getEnabledPluginIdsMock,
  saveAutoUpdateInterval: saveAutoUpdateIntervalMock,
  saveGlobalShortcut: saveGlobalShortcutMock,
  savePaceNotificationSettings: savePaceNotificationSettingsMock,
  saveStartOnLogin: saveStartOnLoginMock,
}))

import { useSettingsSystemActions } from "@/hooks/app/use-settings-system-actions"

describe("useSettingsSystemActions", () => {
  const notificationsOff = {
    almostOut: false,
    closeToLimit: false,
    runningOut: false,
  }

  const notificationArgs = () => ({
    paceNotifications: notificationsOff,
    setPaceNotifications: vi.fn(),
  })

  beforeEach(() => {
    getEnabledPluginIdsMock.mockReset()
    saveAutoUpdateIntervalMock.mockReset()
    saveGlobalShortcutMock.mockReset()
    savePaceNotificationSettingsMock.mockReset()
    saveStartOnLoginMock.mockReset()
    invokeMock.mockReset()
    isTauriMock.mockReset()

    getEnabledPluginIdsMock.mockImplementation((settings: { order: string[]; disabled: string[] }) =>
      settings.order.filter((id) => !settings.disabled.includes(id))
    )
    saveAutoUpdateIntervalMock.mockResolvedValue(undefined)
    saveGlobalShortcutMock.mockResolvedValue(undefined)
    savePaceNotificationSettingsMock.mockResolvedValue(undefined)
    saveStartOnLoginMock.mockResolvedValue(undefined)
    invokeMock.mockResolvedValue({ shortcut: null, active: false, error: null })
    isTauriMock.mockReturnValue(true)
  })

  it("updates auto refresh schedule when at least one plugin is enabled", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000)
    const setAutoUpdateInterval = vi.fn()
    const setAutoUpdateNextAt = vi.fn()

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        setAutoUpdateInterval,
        setAutoUpdateNextAt,
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin: vi.fn().mockResolvedValue(undefined),
        ...notificationArgs(),
      })
    )

    act(() => {
      result.current.handleAutoUpdateIntervalChange(15)
    })

    expect(setAutoUpdateInterval).toHaveBeenCalledWith(15)
    expect(setAutoUpdateNextAt).toHaveBeenCalledWith(910_000)
    expect(saveAutoUpdateIntervalMock).toHaveBeenCalledWith(15)
    nowSpy.mockRestore()
  })

  it("clears next refresh when no enabled plugins remain", () => {
    const setAutoUpdateNextAt = vi.fn()

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: { order: ["codex"], disabled: ["codex"] },
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt,
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin: vi.fn().mockResolvedValue(undefined),
        ...notificationArgs(),
      })
    )

    act(() => {
      result.current.handleAutoUpdateIntervalChange(30)
    })

    expect(setAutoUpdateNextAt).toHaveBeenCalledWith(null)
  })

  it("updates shortcut only after the atomic command succeeds", async () => {
    const setGlobalShortcut = vi.fn()
    const setStartOnLogin = vi.fn()
    const applyStartOnLogin = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: null,
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt: vi.fn(),
        setGlobalShortcut,
        setStartOnLogin,
        applyStartOnLogin,
        ...notificationArgs(),
      })
    )

    invokeMock.mockResolvedValueOnce({ shortcut: "Command+Shift+O", active: true, error: null })
    await act(async () => {
      await result.current.handleGlobalShortcutChange("Command+Shift+O")
      result.current.handleStartOnLoginChange(true)
    })

    expect(setGlobalShortcut).toHaveBeenCalledWith("Command+Shift+O")
    expect(saveGlobalShortcutMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith("update_global_shortcut", {
      shortcut: "Command+Shift+O",
    })

    expect(setStartOnLogin).toHaveBeenCalledWith(true)
    expect(saveStartOnLoginMock).toHaveBeenCalledWith(true)
    expect(applyStartOnLogin).toHaveBeenCalledWith(true)
  })

  it("logs persistence/update failures", async () => {
    const autoError = new Error("auto save failed")
    const shortcutInvokeError = new Error("shortcut invoke failed")
    const startOnLoginSaveError = new Error("start on login save failed")
    const startOnLoginApplyError = new Error("start on login apply failed")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    saveAutoUpdateIntervalMock.mockRejectedValueOnce(autoError)
    invokeMock.mockRejectedValueOnce(shortcutInvokeError)
    saveStartOnLoginMock.mockRejectedValueOnce(startOnLoginSaveError)
    const applyStartOnLogin = vi.fn().mockRejectedValueOnce(startOnLoginApplyError)

    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: null,
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt: vi.fn(),
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin,
        ...notificationArgs(),
      })
    )

    act(() => {
      result.current.handleAutoUpdateIntervalChange(5)
      result.current.handleStartOnLoginChange(false)
    })

    await expect(result.current.handleGlobalShortcutChange(null)).rejects.toThrow(shortcutInvokeError)
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("Failed to save auto-update interval:", autoError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to update global shortcut:", shortcutInvokeError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to save start on login:", startOnLoginSaveError)
      expect(errorSpy).toHaveBeenCalledWith("Failed to update start on login:", startOnLoginApplyError)
    })

    errorSpy.mockRestore()
  })


  it("keeps the previous displayed shortcut when registration or persistence fails", async () => {
    const setGlobalShortcut = vi.fn()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderHook(() => useSettingsSystemActions({
      pluginSettings: null, setAutoUpdateInterval: vi.fn(), setAutoUpdateNextAt: vi.fn(),
      setGlobalShortcut, setStartOnLogin: vi.fn(), applyStartOnLogin: vi.fn(), ...notificationArgs(),
    }))
    for (const failure of ["此组合无法使用", "无法保存快捷键"]) {
      invokeMock.mockRejectedValueOnce(failure)
      await expect(result.current.handleGlobalShortcutChange("Command+K")).rejects.toBe(failure)
      expect(setGlobalShortcut).not.toHaveBeenCalled()
    }
    errorSpy.mockRestore()
  })

  it("persists notification toggles", async () => {
    const setPaceNotifications = vi.fn()
    const enabled = { ...notificationsOff, closeToLimit: true }
    const { result, rerender } = renderHook(
      ({ paceNotifications }) =>
        useSettingsSystemActions({
          pluginSettings: null,
          setAutoUpdateInterval: vi.fn(),
          setAutoUpdateNextAt: vi.fn(),
          setGlobalShortcut: vi.fn(),
          setStartOnLogin: vi.fn(),
          applyStartOnLogin: vi.fn().mockResolvedValue(undefined),
          paceNotifications,
          setPaceNotifications,
        }),
      { initialProps: { paceNotifications: notificationsOff } }
    )

    await act(() => result.current.handlePaceNotificationsChange(enabled))
    expect(setPaceNotifications).toHaveBeenCalledWith(enabled)
    expect(savePaceNotificationSettingsMock).toHaveBeenCalledWith(enabled)

    rerender({ paceNotifications: enabled })
    await act(() => result.current.handlePaceNotificationsChange({ ...enabled, almostOut: true }))
  })

  it("rolls back and rejects when notification settings cannot be saved", async () => {
    const setPaceNotifications = vi.fn()
    const saveError = new Error("notification save failed")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    savePaceNotificationSettingsMock.mockRejectedValueOnce(saveError)
    const enabled = { ...notificationsOff, closeToLimit: true }
    const { result } = renderHook(() =>
      useSettingsSystemActions({
        pluginSettings: null,
        setAutoUpdateInterval: vi.fn(),
        setAutoUpdateNextAt: vi.fn(),
        setGlobalShortcut: vi.fn(),
        setStartOnLogin: vi.fn(),
        applyStartOnLogin: vi.fn().mockResolvedValue(undefined),
        paceNotifications: notificationsOff,
        setPaceNotifications,
      })
    )

    await expect(
      act(() => result.current.handlePaceNotificationsChange(enabled))
    ).rejects.toThrow(saveError)
    expect(setPaceNotifications).toHaveBeenNthCalledWith(1, enabled)
    expect(setPaceNotifications).toHaveBeenNthCalledWith(2, notificationsOff)
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to save pace notification settings:",
      saveError
    )
    errorSpy.mockRestore()
  })
})
