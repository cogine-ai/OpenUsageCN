import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getEnabledPluginIdsMock } = vi.hoisted(() => ({
  getEnabledPluginIdsMock: vi.fn(),
}))

vi.mock("@/lib/settings", () => ({
  getEnabledPluginIds: getEnabledPluginIdsMock,
}))

import {
  AUTO_UPDATE_FAILURE_BACKOFF_MS,
  MAX_TRACKED_RESET_BOUNDARIES_PER_PLUGIN,
  RESET_BOUNDARY_REFRESH_GRACE_MS,
  RESET_BOUNDARY_REFRESH_MIN_DELAY_MS,
  getResetBoundaryRefreshPlan,
  recordAttemptedResetBoundary,
  useProbeAutoUpdate,
} from "@/hooks/app/use-probe-auto-update"
import type { PluginState } from "@/hooks/app/types"

function pluginStateWithReset(pluginId: string, resetsAt: number): PluginState {
  return {
    data: {
      providerId: pluginId,
      displayName: pluginId,
      iconUrl: "",
      lines: [
        {
          type: "progress",
          label: "Quota",
          used: 1,
          limit: 10,
          format: { kind: "percent" },
          resetsAt: new Date(resetsAt).toISOString(),
        },
      ],
    },
    loading: false,
    error: null,
    lastManualRefreshAt: null,
    lastUpdatedAt: null,
  }
}

describe("getResetBoundaryRefreshPlan", () => {
  it("returns only the earliest reset boundary before the fixed refresh", () => {
    const plan = getResetBoundaryRefreshPlan({
      enabledIds: ["codex", "claude", "cursor"],
      pluginStates: {
        codex: pluginStateWithReset("codex", 60_000),
        claude: pluginStateWithReset("claude", 90_000),
        cursor: pluginStateWithReset("cursor", 300_000),
      },
      attemptedBoundaries: new Map(),
      nextAutoUpdateAt: 5 * 60_000,
    })

    expect(plan).toEqual({
      refreshAt: 60_000 + RESET_BOUNDARY_REFRESH_GRACE_MS,
      candidates: [{ pluginId: "codex", boundaryAt: 60_000 }],
    })
  })

  it("ignores attempted, invalid, disabled, already-refreshed, and fixed-refresh-covered boundaries", () => {
    const attemptedBoundary = 60_000
    const invalidState = pluginStateWithReset("invalid", 90_000)
    if (invalidState.data?.lines[0]?.type === "progress") {
      invalidState.data.lines[0].resetsAt = "not-a-date"
    }
    const alreadyRefreshedState = pluginStateWithReset("already-refreshed", 120_000)
    alreadyRefreshedState.lastUpdatedAt = 120_000 + RESET_BOUNDARY_REFRESH_GRACE_MS

    const plan = getResetBoundaryRefreshPlan({
      enabledIds: ["attempted", "invalid", "already-refreshed", "covered"],
      pluginStates: {
        attempted: pluginStateWithReset("attempted", attemptedBoundary),
        invalid: invalidState,
        "already-refreshed": alreadyRefreshedState,
        covered: pluginStateWithReset("covered", 4 * 60_000 + 30_000),
        disabled: pluginStateWithReset("disabled", 30_000),
      },
      attemptedBoundaries: new Map([["attempted", new Set([attemptedBoundary])]]),
      nextAutoUpdateAt: 5 * 60_000,
    })

    expect(plan).toBeNull()
  })

  it("keeps a boundary scheduled when data refreshed before the grace period ended", () => {
    const boundaryAt = 120_000
    const state = pluginStateWithReset("codex", boundaryAt)
    state.lastUpdatedAt = boundaryAt + RESET_BOUNDARY_REFRESH_GRACE_MS - 1

    const plan = getResetBoundaryRefreshPlan({
      enabledIds: ["codex"],
      pluginStates: { codex: state },
      attemptedBoundaries: new Map(),
      nextAutoUpdateAt: 5 * 60_000,
    })

    expect(plan).toEqual({
      refreshAt: boundaryAt + RESET_BOUNDARY_REFRESH_GRACE_MS,
      candidates: [{ pluginId: "codex", boundaryAt }],
    })
  })

  it("keeps only the latest attempted reset boundaries per provider", () => {
    const attemptedBoundaries = new Map<string, Set<number>>()

    for (let boundaryAt = 1; boundaryAt <= MAX_TRACKED_RESET_BOUNDARIES_PER_PLUGIN + 1; boundaryAt++) {
      recordAttemptedResetBoundary(attemptedBoundaries, "codex", boundaryAt)
    }

    expect(attemptedBoundaries.get("codex")?.size).toBe(
      MAX_TRACKED_RESET_BOUNDARIES_PER_PLUGIN
    )
    expect(attemptedBoundaries.get("codex")?.has(1)).toBe(false)
    expect(attemptedBoundaries.get("codex")?.has(2)).toBe(true)
  })
})

describe("useProbeAutoUpdate", () => {
  beforeEach(() => {
    getEnabledPluginIdsMock.mockReset()
    getEnabledPluginIdsMock.mockImplementation((settings: { order: string[]; disabled: string[] }) =>
      settings.order.filter((id) => !settings.disabled.includes(id))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("keeps auto-update cleared when plugin settings are missing", () => {
    const { result } = renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: null,
        autoUpdateInterval: 15,
        pluginStates: {},
        pluginStatesRef: { current: {} },
        setLoadingForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn(() => false),
        startBatch: vi.fn(),
      })
    )

    act(() => {
      result.current.resetAutoUpdateSchedule()
    })

    expect(result.current.autoUpdateNextAt).toBeNull()
  })

  it("resets the schedule when enabled plugins are present", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000)

    const { result } = renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["codex"], disabled: [] },
        autoUpdateInterval: 15,
        pluginStates: {},
        pluginStatesRef: { current: {} },
        setLoadingForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn(() => false),
        startBatch: vi.fn(),
      })
    )

    act(() => {
      result.current.resetAutoUpdateSchedule()
    })

    expect(result.current.autoUpdateNextAt).toBe(910_000)
    nowSpy.mockRestore()
  })

  it("skips providers that are still loading when auto-update fires", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const setLoadingForPlugins = vi.fn()
    const setErrorForPlugins = vi.fn()
    const startBatch = vi.fn().mockResolvedValue(["idle"])
    const isPluginLoading = vi.fn((id: string) => id === "slow")

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["slow", "idle"], disabled: [] },
        autoUpdateInterval: 15,
        pluginStates: {},
        pluginStatesRef: { current: {} },
        setLoadingForPlugins,
        setErrorForPlugins,
        isPluginLoading,
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
    })

    expect(isPluginLoading).toHaveBeenCalledWith("slow")
    expect(isPluginLoading).toHaveBeenCalledWith("idle")
    expect(setLoadingForPlugins).toHaveBeenCalledWith(["idle"])
    expect(startBatch).toHaveBeenCalledWith(["idle"])
    expect(setErrorForPlugins).not.toHaveBeenCalled()
  })

  it("does not start an auto-update batch when every provider is still loading", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const setLoadingForPlugins = vi.fn()
    const setErrorForPlugins = vi.fn()
    const startBatch = vi.fn()

    const { result } = renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["slow"], disabled: [] },
        autoUpdateInterval: 15,
        pluginStates: {},
        pluginStatesRef: { current: {} },
        setLoadingForPlugins,
        setErrorForPlugins,
        isPluginLoading: vi.fn(() => true),
        startBatch,
      })
    )

    expect(result.current.autoUpdateNextAt).toBe(910_000)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
    })

    expect(result.current.autoUpdateNextAt).toBe(1_810_000)
    expect(setLoadingForPlugins).not.toHaveBeenCalled()
    expect(startBatch).not.toHaveBeenCalled()
    expect(setErrorForPlugins).not.toHaveBeenCalled()
  })

  it("backs off failed providers during auto-update", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const setLoadingForPlugins = vi.fn()
    const setErrorForPlugins = vi.fn()
    const startBatch = vi.fn().mockResolvedValue(["healthy"])

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["failed", "healthy"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates: {},
        pluginStatesRef: {
          current: {
            failed: {
              data: null,
              loading: false,
              error: "Auth expired",
              lastErrorAt: Date.now(),
              lastManualRefreshAt: null,
              lastUpdatedAt: null,
            },
          },
        },
        setLoadingForPlugins,
        setErrorForPlugins,
        isPluginLoading: vi.fn(() => false),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })

    expect(setLoadingForPlugins).toHaveBeenCalledWith(["healthy"])
    expect(startBatch).toHaveBeenCalledWith(["healthy"])
    expect(setErrorForPlugins).not.toHaveBeenCalled()
  })

  it("retries failed providers after the auto-update backoff expires", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const setLoadingForPlugins = vi.fn()
    const startBatch = vi.fn().mockResolvedValue(["failed"])

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["failed"], disabled: [] },
        autoUpdateInterval: 15,
        pluginStates: {},
        pluginStatesRef: {
          current: {
            failed: {
              data: null,
              loading: false,
              error: "Auth expired",
              lastErrorAt: Date.now(),
              lastManualRefreshAt: null,
              lastUpdatedAt: null,
            },
          },
        },
        setLoadingForPlugins,
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn(() => false),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_FAILURE_BACKOFF_MS)
    })

    expect(setLoadingForPlugins).toHaveBeenCalledWith(["failed"])
    expect(startBatch).toHaveBeenCalledWith(["failed"])
  })

  it("refreshes only the provider whose reset boundary arrives before the fixed refresh", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const resetAt = 70_000
    const pluginStates = {
      codex: pluginStateWithReset("codex", resetAt),
      claude: pluginStateWithReset("claude", 5 * 60_000),
    }
    const setLoadingForPlugins = vi.fn()
    const startBatch = vi.fn().mockResolvedValue(["codex"])

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["codex", "claude"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates,
        pluginStatesRef: { current: pluginStates },
        setLoadingForPlugins,
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn(() => false),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        resetAt + RESET_BOUNDARY_REFRESH_GRACE_MS - Date.now() - 1
      )
    })
    expect(startBatch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(setLoadingForPlugins).toHaveBeenCalledTimes(1)
    expect(setLoadingForPlugins).toHaveBeenCalledWith(["codex"])
    expect(startBatch).toHaveBeenCalledTimes(1)
    expect(startBatch).toHaveBeenCalledWith(["codex"])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(startBatch).toHaveBeenCalledTimes(1)
  })

  it("retries a reset boundary skipped while its provider is loading", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const resetAt = 20_000
    const loadingState = pluginStateWithReset("loading", resetAt)
    loadingState.loading = true
    const readyState = pluginStateWithReset("ready", resetAt)
    const pluginStates = { loading: loadingState, ready: readyState }
    const startBatch = vi.fn().mockResolvedValue([])
    let loading = true

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["loading", "ready"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates,
        pluginStatesRef: { current: pluginStates },
        setLoadingForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn((id) => id === "loading" && loading),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        resetAt + RESET_BOUNDARY_REFRESH_GRACE_MS - Date.now()
      )
    })

    expect(startBatch).toHaveBeenCalledTimes(1)
    expect(startBatch).toHaveBeenLastCalledWith(["ready"])

    loading = false

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESET_BOUNDARY_REFRESH_MIN_DELAY_MS)
    })

    expect(startBatch).toHaveBeenCalledTimes(2)
    expect(startBatch).toHaveBeenLastCalledWith(["loading"])
  })

  it("re-arms when every boundary candidate is temporarily ineligible", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const resetAt = 20_000
    const loadingState = pluginStateWithReset("loading", resetAt)
    loadingState.loading = true
    const failedState = pluginStateWithReset("failed", resetAt)
    failedState.error = "Auth expired"
    failedState.lastErrorAt = resetAt + RESET_BOUNDARY_REFRESH_GRACE_MS
      - AUTO_UPDATE_FAILURE_BACKOFF_MS + 1
    const pluginStates = { loading: loadingState, failed: failedState }
    const startBatch = vi.fn().mockResolvedValue([])
    let loading = true

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["loading", "failed"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates,
        pluginStatesRef: { current: pluginStates },
        setLoadingForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn((id) => id === "loading" && loading),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        resetAt + RESET_BOUNDARY_REFRESH_GRACE_MS - Date.now()
      )
    })
    expect(startBatch).not.toHaveBeenCalled()

    loading = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESET_BOUNDARY_REFRESH_MIN_DELAY_MS)
    })

    expect(startBatch).toHaveBeenCalledTimes(1)
    expect(startBatch).toHaveBeenCalledWith(["loading", "failed"])
  })

  it("does not postpone an overdue boundary when unrelated plugin state changes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)

    const codex = pluginStateWithReset("codex", 20_000)
    const pluginStatesRef = { current: { codex } as Record<string, PluginState> }
    const startBatch = vi.fn().mockResolvedValue(["codex"])
    const common = {
      pluginSettings: { order: ["codex"], disabled: [] },
      autoUpdateInterval: 5 as const,
      pluginStatesRef,
      setLoadingForPlugins: vi.fn(),
      setErrorForPlugins: vi.fn(),
      isPluginLoading: vi.fn(() => false),
      startBatch,
    }
    const { rerender } = renderHook(
      ({ pluginStates }: { pluginStates: Record<string, PluginState> }) =>
        useProbeAutoUpdate({ ...common, pluginStates }),
      { initialProps: { pluginStates: { codex } } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    const unrelated = pluginStateWithReset("unrelated", 10 * 60_000)
    unrelated.loading = true
    pluginStatesRef.current = { codex, unrelated }
    rerender({ pluginStates: { codex, unrelated } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(startBatch).toHaveBeenCalledTimes(1)
    expect(startBatch).toHaveBeenCalledWith(["codex"])
  })

  it("waits briefly before refreshing an already-passed reset boundary", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)

    const pluginStates = { codex: pluginStateWithReset("codex", 20_000) }
    const startBatch = vi.fn().mockResolvedValue(["codex"])

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["codex"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates,
        pluginStatesRef: { current: pluginStates },
        setLoadingForPlugins: vi.fn(),
        setErrorForPlugins: vi.fn(),
        isPluginLoading: vi.fn(() => false),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESET_BOUNDARY_REFRESH_MIN_DELAY_MS - 1)
    })
    expect(startBatch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(startBatch).toHaveBeenCalledWith(["codex"])
  })

  it("surfaces auto-update batch start failures to plugin state", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const setLoadingForPlugins = vi.fn()
    const setErrorForPlugins = vi.fn()
    const startBatch = vi.fn().mockRejectedValue(new Error("ipc unavailable"))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["codex"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates: {},
        pluginStatesRef: { current: {} },
        setLoadingForPlugins,
        setErrorForPlugins,
        isPluginLoading: vi.fn(() => false),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })

    expect(setLoadingForPlugins).toHaveBeenCalledWith(["codex"])
    expect(startBatch).toHaveBeenCalledWith(["codex"])
    expect(setErrorForPlugins).toHaveBeenCalledWith(["codex"], "无法开始刷新")
    consoleError.mockRestore()
  })

  it("surfaces reset-boundary batch start failures to plugin state", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const resetAt = 20_000
    const pluginStates = { codex: pluginStateWithReset("codex", resetAt) }
    const setLoadingForPlugins = vi.fn()
    const setErrorForPlugins = vi.fn()
    const startBatch = vi.fn().mockRejectedValue(new Error("ipc unavailable"))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    renderHook(() =>
      useProbeAutoUpdate({
        pluginSettings: { order: ["codex"], disabled: [] },
        autoUpdateInterval: 5,
        pluginStates,
        pluginStatesRef: { current: pluginStates },
        setLoadingForPlugins,
        setErrorForPlugins,
        isPluginLoading: vi.fn(() => false),
        startBatch,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        resetAt + RESET_BOUNDARY_REFRESH_GRACE_MS - Date.now()
      )
    })

    expect(setLoadingForPlugins).toHaveBeenCalledWith(["codex"])
    expect(startBatch).toHaveBeenCalledWith(["codex"])
    expect(setErrorForPlugins).toHaveBeenCalledWith(["codex"], "无法开始刷新")
    consoleError.mockRestore()
  })
})
