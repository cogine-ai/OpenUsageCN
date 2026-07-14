import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useProviderStatus } from "@/hooks/use-provider-status"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

const statusPage = { url: "https://status.example.com/" }

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("useProviderStatus", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("does not check plugins without status metadata", () => {
    const { result } = renderHook(() => useProviderStatus("no-status"))

    expect(result.current).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("loads status by plugin id without sending a URL", async () => {
    invokeMock.mockResolvedValue({
      level: "degraded",
      description: "Partial outage",
      updatedAt: "2026-07-14T00:00:00Z",
    })

    const { result } = renderHook(() => useProviderStatus("status-load", statusPage))
    await act(flushPromises)

    expect(result.current?.level).toBe("degraded")
    expect(invokeMock).toHaveBeenCalledWith("get_provider_status", {
      pluginId: "status-load",
    })
  })

  it("deduplicates an in-flight check for the same plugin", async () => {
    let resolveStatus: ((status: {
      level: "degraded"
      description: string
      updatedAt: null
    }) => void) | undefined
    invokeMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveStatus = resolve
      })
    )

    const first = renderHook(() => useProviderStatus("status-pending", statusPage))
    const second = renderHook(() => useProviderStatus("status-pending", statusPage))
    expect(invokeMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveStatus?.({ level: "degraded", description: "Partial outage", updatedAt: null })
      await flushPromises()
    })

    expect(first.result.current?.level).toBe("degraded")
    expect(second.result.current?.level).toBe("degraded")
  })

  it("keeps the last successful status when a later check fails", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock
      .mockResolvedValueOnce({ level: "degraded", description: "Partial outage", updatedAt: null })
      .mockRejectedValueOnce(new Error("network unavailable"))

    const { result } = renderHook(() => useProviderStatus("status-retain", statusPage))
    await act(flushPromises)
    expect(result.current?.level).toBe("degraded")

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000)
      await flushPromises()
    })

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(result.current?.level).toBe("degraded")
    expect(consoleError).toHaveBeenCalledWith(
      "[provider-status] status-retain check failed",
      expect.any(Error)
    )
  })

  it("updates a previous incident back to operational", async () => {
    vi.useFakeTimers()
    invokeMock
      .mockResolvedValueOnce({ level: "outage", description: "Major outage", updatedAt: null })
      .mockResolvedValueOnce({
        level: "operational",
        description: "All Systems Operational",
        updatedAt: null,
      })

    const { result } = renderHook(() => useProviderStatus("status-recovery", statusPage))
    await act(flushPromises)
    expect(result.current?.level).toBe("outage")

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000)
      await flushPromises()
    })

    expect(result.current?.level).toBe("operational")
  })

  it("does not show the previous provider status while switching providers", async () => {
    let resolveNext: ((status: {
      level: "operational"
      description: string
      updatedAt: null
    }) => void) | undefined
    invokeMock
      .mockResolvedValueOnce({
        level: "degraded",
        description: "Partial outage",
        updatedAt: null,
      })
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveNext = resolve
        })
      )

    const { result, rerender } = renderHook(
      ({ pluginId }) => useProviderStatus(pluginId, statusPage),
      { initialProps: { pluginId: "status-switch-a" } }
    )
    await act(flushPromises)
    expect(result.current?.level).toBe("degraded")

    rerender({ pluginId: "status-switch-b" })
    expect(result.current).toBeNull()

    await act(async () => {
      resolveNext?.({
        level: "operational",
        description: "All Systems Operational",
        updatedAt: null,
      })
      await flushPromises()
    })
    expect(result.current?.level).toBe("operational")
  })
})
