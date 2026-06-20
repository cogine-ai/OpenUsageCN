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

  it("clears orphaned loading states when a batch completes", () => {
    vi.useFakeTimers()
    vi.setSystemTime(99_000)
    const { result } = renderHook(() => useProbeState({}))

    act(() => {
      result.current.setLoadingForPlugins(["codex", "claude"])
      result.current.handleProbeResult({
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "",
        lines: [{ type: "text", label: "Now", value: "OK" }],
      })
    })

    expect(result.current.pluginStates.claude?.loading).toBe(true)

    act(() => {
      result.current.clearStuckLoadingForPlugins(["codex", "claude"])
    })

    expect(result.current.pluginStates.codex?.loading).toBe(false)
    expect(result.current.pluginStates.codex?.error).toBeNull()
    expect(result.current.pluginStates.claude?.loading).toBe(false)
    expect(result.current.pluginStates.claude?.error).toBe("无法更新数据，请重试。")
    expect(result.current.pluginStates.claude?.lastErrorAt).toBe(99_000)
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
})
