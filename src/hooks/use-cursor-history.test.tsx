import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

import { useCursorHistory } from "@/hooks/use-cursor-history"

function history(fetchedAtMs: number, accountId = "account-1") {
  return {
    accountId,
    buckets: [],
    coverage: {
      fromMs: 1_787_400_000_000,
      toMs: 1_787_500_000_000,
      fetchedAtMs,
      timeZone: "Asia/Taipei",
      complete: true,
      scope: "sessionVisible" as const,
    },
    totals: {
      meteredChargedUsd: 2.5,
      meteredCoverage: "complete" as const,
    },
  }
}

describe("useCursorHistory", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
  })

  it("shows the cached snapshot while its detail-demand refresh is running", async () => {
    let resolveRefresh!: (value: unknown) => void
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve
    })
    const cached = history(1_787_450_000_000)
    const fresh = history(1_787_500_000_000)
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_cursor_history_snapshot") return Promise.resolve(cached)
      if (command === "refresh_cursor_history") return refreshPromise
      throw new Error(`Unexpected command: ${command}`)
    })

    const { result } = renderHook(() => useCursorHistory("cursor", "account-1"))

    await waitFor(() => expect(result.current.snapshot).toEqual(cached))
    expect(result.current.loading).toBe(false)
    expect(result.current.refreshing).toBe(true)

    await act(async () => {
      resolveRefresh({ snapshot: fresh, stale: false })
      await refreshPromise
    })
    await waitFor(() => expect(result.current.refreshing).toBe(false))
    expect(result.current.snapshot).toEqual(fresh)
    expect(result.current.stale).toBe(false)
  })

  it("ignores an old refresh after the provider and active account change", async () => {
    let resolveOldRefresh!: (value: unknown) => void
    const oldRefresh = new Promise((resolve) => {
      resolveOldRefresh = resolve
    })
    const accountOne = history(1_787_450_000_000, "account-1")
    const accountTwo = history(1_787_500_000_000, "account-2")
    tauri.invoke.mockImplementation((command: string, args: { accountId: string }) => {
      if (command === "get_cursor_history_snapshot") {
        return Promise.resolve(args.accountId === "account-1" ? accountOne : accountTwo)
      }
      if (command === "refresh_cursor_history" && args.accountId === "account-1") {
        return oldRefresh
      }
      if (command === "refresh_cursor_history") {
        return Promise.resolve({ snapshot: accountTwo, stale: false })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const { result, rerender } = renderHook(
      ({ providerId, accountId }) => useCursorHistory(providerId, accountId),
      { initialProps: { providerId: "cursor", accountId: "account-1" } }
    )
    await waitFor(() => expect(result.current.refreshing).toBe(true))

    rerender({ providerId: "cursor-preview", accountId: "account-2" })
    await waitFor(() => expect(result.current.snapshot?.accountId).toBe("account-2"))
    await waitFor(() => expect(result.current.refreshing).toBe(false))

    await act(async () => {
      resolveOldRefresh({ snapshot: accountOne, stale: false })
      await oldRefresh
    })

    expect(result.current.snapshot?.accountId).toBe("account-2")
  })

  it("retries the same account on a new demand and ignores the old response", async () => {
    let resolveOldRefresh!: (value: unknown) => void
    const oldRefresh = new Promise((resolve) => {
      resolveOldRefresh = resolve
    })
    const fresh = history(1_787_500_000_000)
    let snapshotReads = 0
    let refreshes = 0
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_cursor_history_snapshot") {
        snapshotReads += 1
        return Promise.resolve(snapshotReads === 1 ? null : fresh)
      }
      if (command === "refresh_cursor_history") {
        refreshes += 1
        return refreshes === 1
          ? oldRefresh
          : Promise.resolve({ snapshot: fresh, stale: false })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const { result, rerender } = renderHook(
      ({ demandRevision }) =>
        useCursorHistory("cursor", "account-1", demandRevision),
      { initialProps: { demandRevision: 0 } }
    )
    await waitFor(() => expect(refreshes).toBe(1))

    rerender({ demandRevision: 7 })

    await waitFor(() => expect(result.current.snapshot).toEqual(fresh))
    expect(refreshes).toBe(2)

    await act(async () => {
      resolveOldRefresh({ snapshot: history(1_787_450_000_000), stale: false })
      await oldRefresh
    })

    expect(result.current.snapshot).toEqual(fresh)
  })

  it("requests a refresh with the current local time context", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_787_500_000_000)
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480)
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "en-US",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "Asia/Taipei",
    })
    tauri.invoke
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ snapshot: null, stale: false })

    renderHook(() => useCursorHistory("cursor", "account-1"))

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(2))
    expect(tauri.invoke).toHaveBeenLastCalledWith("refresh_cursor_history", {
      providerId: "cursor",
      accountId: "account-1",
      nowMs: 1_787_500_000_000,
      timeZone: "Asia/Taipei",
      utcOffsetSeconds: 28_800,
    })
  })

  it("never displays a cached snapshot owned by another account", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockResolvedValue(history(1_787_500_000_000, "account-2"))

    const { result } = renderHook(() => useCursorHistory("cursor", "account-1"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot).toBeNull()
    expect(result.current.error?.code).toBe("historyUnavailable")
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("keeps a valid cache stale when the refresh command rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const cached = history(1_787_450_000_000)
    tauri.invoke
      .mockResolvedValueOnce(cached)
      .mockRejectedValueOnce(new Error("ipc unavailable"))

    const { result } = renderHook(() => useCursorHistory("cursor", "account-1"))

    await waitFor(() => expect(result.current.error?.code).toBe("historyUnavailable"))
    expect(result.current.snapshot).toEqual(cached)
    expect(result.current.stale).toBe(true)
    expect(result.current.error).toEqual({
      code: "historyUnavailable",
      message: "Unable to load Model Usage. Try again.",
    })
    expect(errorSpy).toHaveBeenCalled()
  })
})
