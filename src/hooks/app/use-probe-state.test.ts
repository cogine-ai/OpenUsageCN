import { renderHook, act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useProbeState } from "@/hooks/app/use-probe-state"

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

  it("uses Chinese fallback text for empty plugin error output", () => {
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "badge", label: "Error", text: "" }],
      })
    })

    expect(result.current.pluginStates.codex?.error).toBe("无法更新数据，请重试。")
  })

  it("tracks error time for auto-update backoff and clears it after success", () => {
    vi.useFakeTimers()
    vi.setSystemTime(123_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "badge", label: "Error", text: "Auth expired" }],
      })
    })

    expect(result.current.pluginStates.codex?.lastErrorAt).toBe(123_000)

    vi.setSystemTime(456_000)
    act(() => {
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "text", label: "Now", value: "OK" }],
      })
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

  it("preserves existing data when a probe returns an error", () => {
    const existingData = {
      providerId: "codex",
      displayName: "Codex",
      iconUrl: "",
      lines: [{ type: "text" as const, label: "Now", value: "OK" }],
    }
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.handleProbeResult(existingData)
    })

    act(() => {
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "badge", label: "Error", text: "Auth expired" }],
      })
    })

    expect(result.current.pluginStates.codex?.data).toEqual(existingData)
    expect(result.current.pluginStates.codex?.error).toBe("Auth expired")
    expect(result.current.pluginStates.codex?.loading).toBe(false)
  })

  it("tracks manual refresh time after a successful probe", () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.manualRefreshIdsRef.current.add("codex")
    })

    act(() => {
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "text", label: "Now", value: "OK" }],
      })
    })

    expect(result.current.pluginStates.codex?.lastManualRefreshAt).toBe(200_000)
    expect(result.current.manualRefreshIdsRef.current.has("codex")).toBe(false)
  })

  it("clears error state when marking plugins loading", () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.setErrorForPlugins(["codex"], "无法开始刷新")
    })

    act(() => {
      result.current.setLoadingForPlugins(["codex"])
    })

    expect(result.current.pluginStates.codex?.loading).toBe(true)
    expect(result.current.pluginStates.codex?.error).toBeNull()
    expect(result.current.pluginStates.codex?.lastErrorAt).toBeNull()
  })

  it("invokes onProbeResult after handling probe output", () => {
    const onProbeResult = vi.fn()
    const { result } = renderHook(() => useProbeState({ onProbeResult }))

    act(() => {
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "text", label: "Now", value: "OK" }],
      })
    })

    expect(onProbeResult).toHaveBeenCalledTimes(1)
  })
})
