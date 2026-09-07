import { startTransition, Suspense, useState } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
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
  let reject!: (reason: string) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
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

  it("clears completed history when the selected account changes", async () => {
    tauri.invoke.mockResolvedValue(history("account-a"))
    const { result, rerender } = renderHook(({ accountId }) => useLocalHistory("claude", accountId), {
      initialProps: { accountId: "account-a" },
    })
    await act(() => result.current.load())
    expect(result.current.snapshot).not.toBeNull()
    rerender({ accountId: "account-b" })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it.each(["success", "error"])("settles the committed account's %s after an uncommitted scope render", async (outcome) => {
    const request = pending<LocalHistorySnapshot>()
    const suspended = pending<void>()
    const attemptedScopeChange = vi.fn()
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockReturnValue(request.promise)

    function HistoryView() {
      const [accountId, setAccountId] = useState("account-a")
      const local = useLocalHistory("claude", accountId)
      if (accountId === "account-b") {
        attemptedScopeChange()
        throw suspended.promise
      }
      return <>
        <p>{accountId}</p>
        <button onClick={() => { void local.load() }}>Load</button>
        <button onClick={() => startTransition(() => setAccountId("account-b"))}>Change Account</button>
        <p>{local.loading ? "Loading" : "Idle"}</p>
        {local.snapshot && <p>History Ready</p>}
        {local.error && <p role="alert">{local.error}</p>}
      </>
    }

    render(<Suspense fallback={<p>Pending Account</p>}><HistoryView /></Suspense>)
    fireEvent.click(screen.getByRole("button", { name: "Load" }))
    fireEvent.click(screen.getByRole("button", { name: "Change Account" }))
    expect(attemptedScopeChange).toHaveBeenCalled()
    expect(screen.getByText("account-a")).toBeInTheDocument()
    expect(screen.queryByText("Pending Account")).not.toBeInTheDocument()

    await act(async () => {
      if (outcome === "success") request.resolve(history("account-a"))
      else request.reject("本地用量暂时无法读取。")
      await request.promise.catch(() => {})
    })

    expect(screen.getByText("Idle")).toBeInTheDocument()
    if (outcome === "success") expect(screen.getByText("History Ready")).toBeInTheDocument()
    else expect(screen.getByRole("alert")).toHaveTextContent("本地用量暂时无法读取。")
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it("ignores a late rejection after unmount", async () => {
    const request = pending<LocalHistorySnapshot>()
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockReturnValue(request.promise)
    const { result, unmount } = renderHook(() => useLocalHistory("claude", "account-a"))
    let load!: Promise<void>
    act(() => { load = result.current.load() })
    unmount()
    await act(async () => { request.reject("Late private error"); await load })
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
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
