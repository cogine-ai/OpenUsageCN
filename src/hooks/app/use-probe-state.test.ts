import { renderHook, act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useProbeState } from "@/hooks/app/use-probe-state"
import type { PluginOutput } from "@/lib/plugin-types"

describe("useProbeState", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("updates pluginStatesRef synchronously when marking plugins loading", () => {
    const { result } = renderHook(() => useProbeState({}))

    let loadingImmediatelyAfterSet: boolean | undefined
    act(() => {
      result.current.setLoadingForPlugins(["codex"])
      loadingImmediatelyAfterSet =
        result.current.pluginStatesRef.current.codex?.loading
    })

    expect(loadingImmediatelyAfterSet).toBe(true)
    expect(result.current.pluginStates.codex?.loading).toBe(true)
  })

  it("clears the previous account projection synchronously for a transition", () => {
    vi.useFakeTimers()
    vi.setSystemTime(123_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "Old Account" }],
        },
        { manual: true }
      )
    })

    let transitionState = result.current.pluginStatesRef.current.codex
    act(() => {
      result.current.setAccountTransitionForPlugins(["codex"])
      transitionState = result.current.pluginStatesRef.current.codex
    })

    expect(transitionState).toMatchObject({
      data: null,
      loading: true,
      error: null,
      lastUpdatedAt: null,
      lastManualRefreshAt: 123_000,
    })
  })

  it("uses Chinese fallback text for empty plugin error output", () => {
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "badge", label: "Error", text: "" }],
        },
        { manual: false }
      )
    })

    expect(result.current.pluginStates.codex?.error).toBe("无法更新数据，请重试。")
  })

  it("tracks error time for auto-update backoff and clears it after success", () => {
    vi.useFakeTimers()
    vi.setSystemTime(123_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "badge", label: "Error", text: "Auth expired" }],
        },
        { manual: false }
      )
    })

    expect(result.current.pluginStates.codex?.lastErrorAt).toBe(123_000)

    vi.setSystemTime(456_000)
    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Now", value: "OK" }],
        },
        { manual: false }
      )
    })

    expect(result.current.pluginStates.codex?.error).toBeNull()
    expect(result.current.pluginStates.codex?.lastErrorAt).toBeNull()
  })

  it("records error time when setErrorForPlugins is called", () => {
    vi.useFakeTimers()
    vi.setSystemTime(789_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.setErrorForPlugins(["codex"], "无法开始刷新")
    })

    expect(result.current.pluginStates.codex?.error).toBe("无法开始刷新")
    expect(result.current.pluginStates.codex?.loading).toBe(false)
    expect(result.current.pluginStates.codex?.lastErrorAt).toBe(789_000)
  })

  it("preserves stale data and lastUpdatedAt when a probe returns an error badge", () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "42%" }],
        },
        { manual: false }
      )
    })

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "badge", label: "Error", text: "Auth expired" }],
        },
        { manual: false }
      )
    })

    const state = result.current.pluginStates.codex
    expect(state?.error).toBe("Auth expired")
    expect(state?.data?.lines[0]).toEqual({ type: "text", label: "Usage", value: "42%" })
    expect(state?.lastUpdatedAt).toBe(200_000)
    expect(state?.lastErrorAt).toBe(200_000)
  })

  it("surfaces plugin panic output as an error without replacing existing data", () => {
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "42%" }],
        },
        { manual: false }
      )
    })

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [
            {
              type: "badge",
              label: "Error",
              text: "The plugin crashed during refresh. Try again or update the plugin.",
            },
          ],
        },
        { manual: false }
      )
    })

    const state = result.current.pluginStates.codex
    expect(state?.error).toBe(
      "The plugin crashed during refresh. Try again or update the plugin."
    )
    expect(state?.data?.lines[0]).toEqual({ type: "text", label: "Usage", value: "42%" })
  })

  it("preserves existing quota and success timestamps when a manual refresh returns partial progress with an error", () => {
    vi.useFakeTimers()
    vi.setSystemTime(400_000)
    const { result } = renderHook(() => useProbeState({}))
    const previous: PluginOutput = {
      providerId: "codex",
      displayName: "Codex",
      iconUrl: "",
      lines: [{ type: "progress", label: "Session", used: 42, limit: 100, format: { kind: "percent" } }],
    }
    act(() => result.current.handleProbeResult(previous, { manual: true }))

    vi.setSystemTime(500_000)
    act(() => {
      result.current.setLoadingForPlugins(["codex"])
      result.current.handleProbeResult(
        {
          ...previous,
          lines: [
            { type: "progress", label: "Session", used: 90, limit: 100, format: { kind: "percent" } },
            { type: "badge", label: "Error", text: "Weekly usage request failed" },
          ],
        },
        { manual: true }
      )
    })

    const state = result.current.pluginStates.codex
    expect(state?.data).toBe(previous)
    expect(state?.data?.lines[0]).toMatchObject({ type: "progress", used: 42 })
    expect(state).toMatchObject({
      loading: false,
      error: "Weekly usage request failed",
      lastErrorAt: 500_000,
      lastUpdatedAt: 400_000,
      lastManualRefreshAt: 400_000,
    })
  })

  it("preserves newer Claude quota and success timestamps when a manual refresh returns rate-limited cached quota", () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const { result } = renderHook(() => useProbeState({}))
    const previous: PluginOutput = {
      providerId: "claude",
      displayName: "Claude",
      iconUrl: "",
      lines: [{ type: "progress", label: "Session", used: 36, limit: 100, format: { kind: "percent" } }],
    }
    act(() => result.current.handleProbeResult(previous, { manual: true }))

    vi.setSystemTime(200_000)
    const recent: PluginOutput = {
      ...previous,
      lines: [{ type: "progress", label: "Session", used: 67, limit: 100, format: { kind: "percent" } }],
    }
    act(() => result.current.handleProbeResult(recent, { manual: false }))

    vi.setSystemTime(300_000)
    act(() => {
      result.current.setLoadingForPlugins(["claude"])
      result.current.handleProbeResult(
        {
          ...previous,
          lines: [
            { type: "badge", label: "Status", text: "Rate limited, retry in ~10m", color: "#f59e0b" },
            { type: "progress", label: "Session", used: 12, limit: 100, format: { kind: "percent" } },
            { type: "text", label: "Note", value: "Live usage rate limited — retry in ~10m" },
          ],
        },
        { manual: true }
      )
    })

    const state = result.current.pluginStates.claude
    expect(state?.data).toBe(recent)
    expect(state?.data?.lines[0]).toMatchObject({ type: "progress", used: 67 })
    expect(state).toMatchObject({
      loading: false,
      error: "服务商暂时限制请求；当前数据来自上次读取。请稍后重试。",
      lastErrorAt: 300_000,
      lastUpdatedAt: 200_000,
      lastManualRefreshAt: 100_000,
    })
  })

  it("keeps cached Claude quota on cold start without recording a rate-limited refresh as successful", () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const { result } = renderHook(() => useProbeState({}))
    const cached: PluginOutput = {
      providerId: "claude",
      displayName: "Claude",
      iconUrl: "",
      lines: [
        { type: "badge", label: "Status", text: "Rate limited, try again later", color: "#f59e0b" },
        { type: "progress", label: "Session", used: 12, limit: 100, format: { kind: "percent" } },
        { type: "text", label: "Note", value: "Live usage rate limited — data may be stale" },
      ],
    }
    expect(result.current.pluginStates.claude).toBeUndefined()

    act(() => result.current.handleProbeResult(cached, { manual: true }))

    const state = result.current.pluginStates.claude
    expect(state?.data).toBe(cached)
    expect(state?.data?.lines[1]).toMatchObject({ type: "progress", used: 12 })
    expect(state).toMatchObject({
      loading: false,
      error: "服务商暂时限制请求；当前数据来自上次读取。请稍后重试。",
      lastErrorAt: 300_000,
      lastUpdatedAt: null,
      lastManualRefreshAt: null,
    })
  })

  it("records manual refresh time only after successful probe results", () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "42%" }],
        },
        { manual: true }
      )
    })

    expect(result.current.pluginStates.codex?.lastManualRefreshAt).toBe(300_000)

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "badge", label: "Error", text: "Auth expired" }],
        },
        { manual: true }
      )
    })

    expect(result.current.pluginStates.codex?.lastManualRefreshAt).toBe(300_000)
  })

  it("does not attribute a newer non-manual result to an older manual refresh", () => {
    vi.useFakeTimers()
    vi.setSystemTime(400_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "42%" }],
        },
        { manual: false }
      )
    })

    expect(result.current.pluginStates.codex?.lastManualRefreshAt).toBeNull()
  })

  it("calls onProbeResult after each probe result", () => {
    const onProbeResult = vi.fn()
    const { result } = renderHook(() => useProbeState({ onProbeResult }))

    act(() => {
      result.current.handleProbeResult(
        {
          providerId: "codex",
          displayName: "Codex",
          iconUrl: "",
          lines: [{ type: "text", label: "Usage", value: "42%" }],
        },
        { manual: false }
      )
    })

    expect(onProbeResult).toHaveBeenCalledTimes(1)
  })
})
