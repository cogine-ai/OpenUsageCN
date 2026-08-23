import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}))

import { useProviderAccounts } from "@/hooks/use-provider-accounts"

function view(providerId: string, activeAccountId: string | null) {
  return {
    providerId,
    selection: { mode: "auto" as const },
    activeAccountId,
    accounts: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe("useProviderAccounts view-change events", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listeners.clear()
    tauri.unlisten.mockReset()
    tauri.listen.mockImplementation(
      async (eventName: string, listener: (event: { payload: unknown }) => void) => {
        tauri.listeners.set(eventName, listener)
        return tauri.unlisten
      }
    )
  })

  it("fresh-reads only when the current provider changes", async () => {
    tauri.invoke
      .mockResolvedValueOnce(view("cursor", "account-1"))
      .mockResolvedValueOnce(view("cursor", "account-2"))
    const { result } = renderHook(() => useProviderAccounts("cursor"))

    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("account-1"))
    await waitFor(() =>
      expect(tauri.listeners.has("provider-account-view-changed")).toBe(true)
    )

    act(() => {
      tauri.listeners.get("provider-account-view-changed")?.({
        payload: { providerId: "codex", revision: 2 },
      })
    })
    expect(tauri.invoke).toHaveBeenCalledTimes(1)

    act(() => {
      tauri.listeners.get("provider-account-view-changed")?.({
        payload: { providerId: "cursor", revision: 3 },
      })
    })

    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("account-2"))
    expect(result.current.accountRevision).toBe(3)
    expect(tauri.invoke).toHaveBeenLastCalledWith("get_provider_account_view", {
      providerId: "cursor",
    })
    expect(tauri.invoke).toHaveBeenCalledTimes(2)
  })

  it("establishes the subscription before the initial fresh read", async () => {
    const listenerReady = deferred<() => void>()
    let serverView = view("cursor", "account-1")
    tauri.listen.mockReturnValueOnce(listenerReady.promise)
    tauri.invoke.mockImplementation(() => Promise.resolve(serverView))

    const { result } = renderHook(() => useProviderAccounts("cursor"))

    serverView = view("cursor", "account-2")
    act(() => listenerReady.resolve(tauri.unlisten))

    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("account-2"))
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it("loads the view but keeps a visible warning when account events cannot subscribe", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.listen.mockRejectedValueOnce(new Error("event bridge unavailable"))
    tauri.invoke.mockResolvedValue(view("cursor", "account-1"))

    const { result } = renderHook(() => useProviderAccounts("cursor"))

    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("account-1"))
    expect(result.current.error).toBe("账号实时更新不可用，请重新打开此页面")
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to listen for provider account changes:",
      expect.any(Error)
    )
  })

  it("keeps the newest fresh read when event responses resolve out of order", async () => {
    const olderRead = deferred<ReturnType<typeof view>>()
    const newerRead = deferred<ReturnType<typeof view>>()
    tauri.invoke
      .mockResolvedValueOnce(view("cursor", "account-1"))
      .mockReturnValueOnce(olderRead.promise)
      .mockReturnValueOnce(newerRead.promise)
    const { result } = renderHook(() => useProviderAccounts("cursor"))

    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("account-1"))
    await waitFor(() =>
      expect(tauri.listeners.has("provider-account-view-changed")).toBe(true)
    )

    act(() => {
      tauri.listeners.get("provider-account-view-changed")?.({
        payload: { providerId: "cursor", revision: 2 },
      })
    })
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(2))

    act(() => {
      tauri.listeners.get("provider-account-view-changed")?.({
        payload: { providerId: "cursor", revision: 3 },
      })
    })
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(3))

    act(() => newerRead.resolve(view("cursor", "account-3")))
    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("account-3"))

    await act(async () => {
      olderRead.resolve(view("cursor", "account-2"))
      await olderRead.promise
    })
    expect(result.current.view?.activeAccountId).toBe("account-3")
  })

  it("coalesces a burst of newer revisions into one fresh read", async () => {
    tauri.invoke.mockResolvedValue(view("cursor", "account-1"))
    const { result } = renderHook(() => useProviderAccounts("cursor"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() =>
      expect(tauri.listeners.has("provider-account-view-changed")).toBe(true)
    )

    act(() => {
      for (const revision of [2, 3, 4]) {
        tauri.listeners.get("provider-account-view-changed")?.({
          payload: { providerId: "cursor", revision },
        })
      }
    })

    await waitFor(() => expect(result.current.accountRevision).toBe(4))
    expect(tauri.invoke).toHaveBeenCalledTimes(2)
  })

  it("cleans up delayed listeners across StrictMode-style repeated setup", async () => {
    const firstListen = deferred<() => void>()
    const secondListen = deferred<() => void>()
    const firstUnlisten = vi.fn()
    const secondUnlisten = vi.fn()
    tauri.listen
      .mockReturnValueOnce(firstListen.promise)
      .mockReturnValueOnce(secondListen.promise)
    tauri.invoke.mockResolvedValue(view("cursor", "account-1"))

    const { rerender, unmount } = renderHook(
      ({ providerId }) => useProviderAccounts(providerId),
      { initialProps: { providerId: "cursor" } }
    )
    rerender({ providerId: "codex" })
    expect(tauri.listen).toHaveBeenCalledTimes(2)

    act(() => firstListen.resolve(firstUnlisten))
    await waitFor(() => expect(firstUnlisten).toHaveBeenCalledTimes(1))

    act(() => secondListen.resolve(secondUnlisten))
    await waitFor(() => expect(secondUnlisten).not.toHaveBeenCalled())
    unmount()

    expect(secondUnlisten).toHaveBeenCalledTimes(1)
  })
})
