import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LocalHistorySnapshot } from "@/lib/local-history"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { useLocalHistory } from "@/hooks/use-local-history"

function history(accountId: string | null, value = "12K tokens"): LocalHistorySnapshot {
  return { providerId: accountId ? "claude" : "codex", accountId,
    fetchedAt: "2026-09-07T00:00:00Z", lines: [{ type: "text", label: "Today", value }] }
}

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("useLocalHistory", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("waits for explicit demand and uses an independent camelCase command", async () => {
    tauri.invoke.mockResolvedValue(history(null))
    const { result } = renderHook(() => useLocalHistory("codex", null))
    expect(tauri.invoke).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)

    await act(() => result.current.load())

    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("refresh_local_history", { providerId: "codex", accountId: null })
    expect(result.current.snapshot).toEqual(history(null))
  })

  it("discards pending history immediately when the selected account changes", async () => {
    const old = pending<LocalHistorySnapshot>()
    tauri.invoke.mockReturnValueOnce(old.promise).mockResolvedValueOnce(history("account-b"))
    const { result, rerender } = renderHook(({ accountId }) => useLocalHistory("claude", accountId), {
      initialProps: { accountId: "account-a" },
    })
    let oldLoad!: Promise<void>
    act(() => { oldLoad = result.current.load() })
    expect(result.current.loading).toBe(true)
    rerender({ accountId: "account-b" })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.loading).toBe(false)
    await act(() => result.current.load())
    await act(async () => { old.resolve(history("account-a")); await oldLoad })
    expect(result.current.snapshot?.accountId).toBe("account-b")
  })

  it("clears completed and pending history after an account generation revision", async () => {
    const old = pending<LocalHistorySnapshot>()
    tauri.invoke.mockResolvedValueOnce(history("account-a")).mockReturnValueOnce(old.promise)
    const { result, rerender } = renderHook(({ revision }) => useLocalHistory("claude", "account-a", revision), {
      initialProps: { revision: 0 },
    })
    await act(() => result.current.load())
    expect(result.current.snapshot).not.toBeNull()
    let oldLoad!: Promise<void>
    act(() => { oldLoad = result.current.load() })
    rerender({ revision: 1 })
    await act(async () => { old.resolve(history("account-a")); await oldLoad })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(tauri.invoke).toHaveBeenCalledTimes(2)
  })

  it("keeps only the latest explicit request", async () => {
    const first = pending<LocalHistorySnapshot>()
    tauri.invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce(history(null, "Fresh"))
    const { result } = renderHook(() => useLocalHistory("codex", null))
    let oldLoad!: Promise<void>
    act(() => { oldLoad = result.current.load() })
    await act(() => result.current.load())
    await act(async () => { first.resolve(history(null, "Old")); await oldLoad })
    expect(result.current.snapshot?.lines[0]).toMatchObject({ value: "Fresh" })
  })

  it("clears old history on a failed refresh and shows the friendly error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockResolvedValueOnce(history(null)).mockRejectedValueOnce("本地用量暂时无法读取。")
    const { result } = renderHook(() => useLocalHistory("codex", null))
    await act(() => result.current.load())
    await act(() => result.current.load())
    expect(result.current.snapshot).toBeNull()
    expect(result.current.error).toBe("本地用量暂时无法读取。")
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it("rejects a mismatched scope without exposing its history", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockResolvedValue(history("other-account"))
    const { result } = renderHook(() => useLocalHistory("claude", "account-a"))
    await act(() => result.current.load())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.snapshot).toBeNull()
    log.mockRestore()
  })
})
