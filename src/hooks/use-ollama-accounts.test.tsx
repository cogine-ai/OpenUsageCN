import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OllamaAccountsView } from "@/lib/ollama-accounts"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { useOllamaAccounts } from "./use-ollama-accounts"

function view(
  revision = 1,
  primary: OllamaAccountsView["primary"] = { mode: "connection", connectionId: "home" }
): OllamaAccountsView {
  return { revision, primary, connections: [] }
}

describe("Ollama connection state", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset().mockResolvedValue(vi.fn())
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === "get_ollama_accounts" ? view() : view(2))
    )
  })

  it("does not let a late initial read overwrite a newer successful mutation", async () => {
    let finishRead: (value: unknown) => void = () => {}
    tauri.invoke.mockImplementation((command) =>
      command === "get_ollama_accounts"
        ? new Promise((resolve) => {
            finishRead = resolve
          })
        : Promise.resolve(view(3, { mode: "connection", connectionId: "work" }))
    )
    const { result } = renderHook(() => useOllamaAccounts())
    await act(() => result.current.operate({ kind: "selectPrimary", connectionId: "work" }))
    await act(async () => finishRead(view()))
    expect(result.current.view?.revision).toBe(3)
    expect(result.current.view?.primary.connectionId).toBe("work")
  })

  it("routes unchanged-primary refresh separately from an actual primary transition", async () => {
    const changed = vi.fn(),
      refreshed = vi.fn()
    const { result } = renderHook(() => useOllamaAccounts(changed, refreshed))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.operate({ kind: "refresh", connectionId: "work" }))
    expect(changed).not.toHaveBeenCalled()
    expect(refreshed).not.toHaveBeenCalled()
    await act(() => result.current.operate({ kind: "refresh", connectionId: "home" }))
    expect(refreshed).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    await act(() => result.current.operate({ kind: "remove", connectionId: "home" }))
    expect(changed).toHaveBeenCalledOnce()
  })

  it("clears the main projection only for replacement of its selected key", async () => {
    const changed = vi.fn()
    const { result } = renderHook(() => useOllamaAccounts(changed))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.save("verification-work", "Work", false, "work"))
    expect(changed).not.toHaveBeenCalled()
    await act(() => result.current.save("verification-other", "Other", true, "home"))
    expect(changed).not.toHaveBeenCalled()
    await act(() => result.current.save("verification-home", "Home", false, "home"))
    expect(changed).toHaveBeenCalledOnce()
  })

  it("reloads actual state after a failed mutation without exposing an unsafe exception", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    let read = 0
    tauri.invoke.mockImplementation((command) =>
      command === "get_ollama_accounts"
        ? Promise.resolve(read++ === 0 ? view() : view(4, { mode: "none" }))
        : Promise.reject(new Error("unsafe API key response"))
    )
    const { result } = renderHook(() => useOllamaAccounts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.operate({ kind: "remove", connectionId: "home" }))
    expect(result.current.view?.primary.mode).toBe("none")
    expect(result.current.error).toContain("重新读取连接状态")
    expect(result.current.error).not.toContain("unsafe")
    expect(log).toHaveBeenCalledWith("Failed to update Ollama account connection")
  })

  it.each([
    "验证结果已过期，请重新验证 Key。",
    "批量刷新已超时，未完成的连接保留原数据，请分别刷新。",
  ])("shows the owned command's actionable message: %s", async (message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockImplementation((command) =>
      command === "get_ollama_accounts" ? Promise.resolve(view()) : Promise.reject(message)
    )
    const { result } = renderHook(() => useOllamaAccounts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.operate({ kind: "refresh" }))
    expect(result.current.error).toBe(message)
    expect(result.current.busy).toBe(false)
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "get_ollama_accounts")).toHaveLength(2)
    expect(log).toHaveBeenCalledExactlyOnceWith("Failed to update Ollama account connection")
  })

  it.each(["", {}, null])("keeps a friendly fallback for an unexpected IPC failure: %j", async (reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockImplementation((command) =>
      command === "get_ollama_accounts" ? Promise.resolve(view()) : Promise.reject(reason)
    )
    const { result } = renderHook(() => useOllamaAccounts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.operate({ kind: "refresh" }))
    expect(result.current.error).toBe("账号操作未完成，请重新读取连接状态后重试。")
  })

  it("unsubscribes and ignores an operation that finishes after leaving the page", async () => {
    let finish: (value: unknown) => void = () => {}
    const stop = vi.fn(),
      changed = vi.fn()
    tauri.listen.mockResolvedValue(stop)
    tauri.invoke.mockImplementation((command) =>
      command === "get_ollama_accounts"
        ? Promise.resolve(view())
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    const { result, unmount } = renderHook(() => useOllamaAccounts(changed))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let mutation: ReturnType<typeof result.current.operate> = Promise.resolve(null)
    act(() => {
      mutation = result.current.operate({ kind: "selectPrimary", connectionId: "work" })
    })
    unmount()
    await act(async () => {
      finish(view(2))
      await mutation
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
  })
})
