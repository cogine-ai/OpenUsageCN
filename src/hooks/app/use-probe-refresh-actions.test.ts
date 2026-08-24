import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getEnabledPluginIdsMock } = vi.hoisted(() => ({
  getEnabledPluginIdsMock: vi.fn(),
}))

vi.mock("@/lib/settings", () => ({
  REFRESH_COOLDOWN_MS: 300_000,
  getEnabledPluginIds: getEnabledPluginIdsMock,
}))

import { useProbeRefreshActions } from "@/hooks/app/use-probe-refresh-actions"
import { useProbeState } from "@/hooks/app/use-probe-state"
import { ProbeBatchStartError } from "@/hooks/use-probe-events"

describe("useProbeRefreshActions", () => {
  beforeEach(() => {
    getEnabledPluginIdsMock.mockReset()
    getEnabledPluginIdsMock.mockImplementation((settings: { order: string[]; disabled: string[] }) =>
      settings.order.filter((id) => !settings.disabled.includes(id))
    )
  })

  it("retries one plugin via manual refresh", () => {
    const startBatch = vi.fn().mockResolvedValue([])
    const setLoadingForPlugins = vi.fn()

    const { result } = renderHook(() =>
      useProbeRefreshActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        pluginStatesRef: { current: {} },
        resetAutoUpdateSchedule: vi.fn(),
        setLoadingForPlugins,
        setAccountTransitionForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        startBatch,
      })
    )

    act(() => {
      result.current.handleRetryPlugin("codex")
    })

    expect(setLoadingForPlugins).toHaveBeenCalledWith(["codex"])
    expect(startBatch).toHaveBeenCalledWith(["codex"], { manual: true })
  })

  it.each([
    {
      name: "loading",
      state: {
        data: null,
        loading: true,
        error: null,
        lastManualRefreshAt: null,
        lastUpdatedAt: null,
      },
    },
    {
      name: "manual cooldown",
      state: {
        data: null,
        loading: false,
        error: null,
        lastManualRefreshAt: 999_999,
        lastUpdatedAt: null,
      },
    },
  ])("starts an account-change batch during $name while Retry stays guarded", ({ state }) => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    const startBatch = vi.fn().mockResolvedValue([])
    const setLoadingForPlugins = vi.fn()
    const setAccountTransitionForPlugins = vi.fn()
    const resetAutoUpdateSchedule = vi.fn()
    const { result } = renderHook(() =>
      useProbeRefreshActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        pluginStatesRef: { current: { codex: state } },
        resetAutoUpdateSchedule,
        setLoadingForPlugins,
        setAccountTransitionForPlugins,
        setErrorForPlugins: vi.fn(),
        startBatch,
      })
    )

    act(() => {
      result.current.handleRetryPlugin("codex")
    })
    expect(startBatch).not.toHaveBeenCalled()

    act(() => {
      result.current.handleAccountChangeRefresh("codex")
    })

    expect(resetAutoUpdateSchedule).toHaveBeenCalledTimes(1)
    expect(setLoadingForPlugins).not.toHaveBeenCalled()
    expect(setAccountTransitionForPlugins).toHaveBeenCalledWith(["codex"])
    expect(startBatch).toHaveBeenCalledWith(["codex"], {
      invalidatePreviousOnFailure: true,
    })
  })

  it("clears old account data and ends loading when the transition batch fails", async () => {
    const failure = new Error("batch failed")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderHook(() => {
      const probeState = useProbeState({})
      const actions = useProbeRefreshActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        pluginStatesRef: probeState.pluginStatesRef,
        resetAutoUpdateSchedule: vi.fn(),
        setLoadingForPlugins: probeState.setLoadingForPlugins,
        setAccountTransitionForPlugins: probeState.setAccountTransitionForPlugins,
        setErrorForPlugins: probeState.setErrorForPlugins,
        startBatch: vi.fn().mockRejectedValue(failure),
      })
      return { ...probeState, ...actions }
    })

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "Old Account" }],
        },
        { manual: false }
      )
    })

    let transitionState = result.current.pluginStatesRef.current.codex
    act(() => {
      result.current.handleAccountChangeRefresh("codex")
      transitionState = result.current.pluginStatesRef.current.codex
    })

    expect(transitionState?.data).toBeNull()
    expect(transitionState?.loading).toBe(true)
    await waitFor(() => expect(result.current.pluginStates.codex?.loading).toBe(false))
    expect(result.current.pluginStates.codex?.error).toBe("无法开始刷新")
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to refresh plugin after account change:",
      failure
    )
  })

  it("filters out ineligible plugins for refresh-all", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    const startBatch = vi.fn().mockResolvedValue([])
    const setLoadingForPlugins = vi.fn()

    const { result } = renderHook(() =>
      useProbeRefreshActions({
        pluginSettings: { order: ["a", "b", "c"], disabled: [] },
        pluginStatesRef: {
          current: {
            a: { data: null, loading: true, error: null, lastManualRefreshAt: null, lastUpdatedAt: null },
            b: { data: null, loading: false, error: null, lastManualRefreshAt: 900_001, lastUpdatedAt: null },
            c: { data: null, loading: false, error: null, lastManualRefreshAt: null, lastUpdatedAt: null },
          },
        },
        resetAutoUpdateSchedule: vi.fn(),
        setLoadingForPlugins,
        setAccountTransitionForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        startBatch,
      })
    )

    act(() => {
      result.current.handleRefreshAll()
    })

    expect(setLoadingForPlugins).toHaveBeenCalledWith(["c"])
    expect(startBatch).toHaveBeenCalledWith(["c"], { manual: true })
    nowSpy.mockRestore()
  })

  it("returns early when settings are unavailable or no plugins are eligible", () => {
    const startBatch = vi.fn()
    const resetAutoUpdateSchedule = vi.fn()

    const { result, rerender } = renderHook(
      ({ settings }: { settings: { order: string[]; disabled: string[] } | null }) =>
        useProbeRefreshActions({
          pluginSettings: settings,
          pluginStatesRef: {
            current: {
              codex: { data: null, loading: true, error: null, lastManualRefreshAt: null, lastUpdatedAt: null },
            },
          },
          resetAutoUpdateSchedule,
          setLoadingForPlugins: vi.fn(),
          setAccountTransitionForPlugins: vi.fn(),
          setErrorForPlugins: vi.fn(),
          startBatch,
        }),
      { initialProps: { settings: null } }
    )

    act(() => {
      result.current.handleRefreshAll()
    })
    expect(startBatch).not.toHaveBeenCalled()

    getEnabledPluginIdsMock.mockReturnValueOnce([])
    rerender({ settings: { order: ["codex"], disabled: [] } })
    act(() => {
      result.current.handleRefreshAll()
    })
    expect(startBatch).not.toHaveBeenCalled()
    expect(resetAutoUpdateSchedule).not.toHaveBeenCalled()
  })

  it("sets errors when a manual batch fails to start", async () => {
    const failure = new Error("batch failed")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const setErrorForPlugins = vi.fn()

    const { result } = renderHook(() =>
      useProbeRefreshActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        pluginStatesRef: { current: {} },
        resetAutoUpdateSchedule: vi.fn(),
        setLoadingForPlugins: vi.fn(),
        setAccountTransitionForPlugins: vi.fn(),
        setErrorForPlugins,
        startBatch: vi.fn().mockRejectedValueOnce(failure),
      })
    )

    act(() => {
      result.current.handleRetryPlugin("codex")
    })

    await waitFor(() => {
      expect(setErrorForPlugins).toHaveBeenCalledWith(["codex"], "无法开始刷新")
      expect(errorSpy).toHaveBeenCalledWith("Failed to retry plugin:", failure)
    })

    errorSpy.mockRestore()
  })

  it("keeps the restored provider loading when an overlapping start fails", async () => {
    const cause = new Error("batch failed")
    const failure = new ProbeBatchStartError(cause, [])
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const setErrorForPlugins = vi.fn()

    const { result } = renderHook(() =>
      useProbeRefreshActions({
        pluginSettings: { order: ["codex"], disabled: [] },
        pluginStatesRef: { current: {} },
        resetAutoUpdateSchedule: vi.fn(),
        setLoadingForPlugins: vi.fn(),
        setAccountTransitionForPlugins: vi.fn(),
        setErrorForPlugins,
        startBatch: vi.fn().mockRejectedValueOnce(failure),
      })
    )

    act(() => {
      result.current.handleRetryPlugin("codex")
    })

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("Failed to retry plugin:", failure)
    })
    expect(setErrorForPlugins).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
