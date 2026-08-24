import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}))

import { useProviderAccounts } from "@/hooks/use-provider-accounts"

describe("useProviderAccounts", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listen.mockResolvedValue(vi.fn())
  })

  it("loads the provider account view", async () => {
    tauri.invoke.mockResolvedValue({
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: "account-1",
      accounts: [
        {
          accountId: "account-1",
          label: "Work",
          connectionKinds: ["desktop"],
          selected: true,
          stale: false,
        },
      ],
    })

    const { result } = renderHook(() => useProviderAccounts("cursor"))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.view?.activeAccountId).toBe("account-1")
    expect(result.current.error).toBeNull()
  })

  it("selects a pinned account and publishes the returned view", async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "account-1",
        accounts: [],
      })
      .mockResolvedValueOnce({
        operationId: "operation-1",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          providerId: "cursor",
          selection: { mode: "pinned", accountId: "account-2" },
          activeAccountId: "account-2",
          accounts: [],
        },
      })
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.selectAccount("account-2")
    })

    expect(result.current.view?.selection).toEqual({
      mode: "pinned",
      accountId: "account-2",
    })
    expect(result.current.receipt?.status).toBe("succeeded")
    expect(result.current.busy).toBe(false)
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: { kind: "selectActive", accountId: "account-2" },
    })
  })

  it("returns to automatic selection by following the default connection", async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "pinned", accountId: "account-2" },
        activeAccountId: "account-2",
        accounts: [],
      })
      .mockResolvedValueOnce({
        operationId: "operation-2",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "account-1",
          accounts: [],
        },
      })
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.followDefault()
    })

    expect(result.current.view?.selection).toEqual({ mode: "auto" })
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: { kind: "followDefaultConnection" },
    })
  })

  it("refreshes the active account and keeps a partial receipt", async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "account-1",
        accounts: [],
      })
      .mockResolvedValueOnce({
        operationId: "operation-3",
        status: "partial",
        sourceOutcomes: [
          { sourceKey: "cursorDesktop", status: "available" },
          { sourceKey: "cursorCli", status: "unavailable" },
        ],
        view: {
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "account-1",
          accounts: [],
        },
      })
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.refreshActive()
    })

    expect(result.current.receipt?.status).toBe("partial")
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: { kind: "refreshActive" },
    })
  })

  it("renames an account through the provider operation", async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "account-1",
        accounts: [],
      })
      .mockResolvedValueOnce({
        operationId: "operation-4",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "account-1",
          accounts: [
            {
              accountId: "account-1",
              label: "Personal",
              connectionKinds: ["desktop"],
              selected: true,
              stale: false,
            },
          ],
        },
      })
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.renameAccount("account-1", "Personal")
    })

    expect(result.current.view?.accounts[0]?.label).toBe("Personal")
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: { kind: "renameAccount", accountId: "account-1", label: "Personal" },
    })
  })

  it("attaches a verified browser candidate and publishes its receipt view", async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: null,
        accounts: [],
      })
      .mockResolvedValueOnce({
        operationId: "operation-attach",
        status: "succeeded",
        sourceOutcomes: [{ sourceKey: "Profile 2", status: "available" }],
        view: {
          providerId: "cursor",
          selection: { mode: "pinned", accountId: "account-browser" },
          activeAccountId: "account-browser",
          accounts: [
            {
              accountId: "account-browser",
              label: "Account 1",
              connectionKinds: ["chrome"],
              connections: [
                {
                  connectionId: "connection-browser",
                  kind: "chrome",
                  available: true,
                  profileKey: "Profile 2",
                },
              ],
              selected: true,
              stale: false,
            },
          ],
        },
      })
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.attachBrowserCandidate("candidate-1")
    })

    expect(result.current.view?.activeAccountId).toBe("account-browser")
    expect(result.current.view?.accounts[0]?.connections[0]?.profileKey).toBe("Profile 2")
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: { kind: "attachBrowserCandidate", candidateId: "candidate-1" },
    })
  })

  it("detaches one browser connection and publishes the retained account", async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "pinned", accountId: "account-1" },
        activeAccountId: "account-1",
        accounts: [],
      })
      .mockResolvedValueOnce({
        operationId: "operation-detach",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          providerId: "cursor",
          selection: { mode: "pinned", accountId: "account-1" },
          activeAccountId: "account-1",
          accounts: [
            {
              accountId: "account-1",
              label: "Work",
              connectionKinds: ["chrome"],
              connections: [],
              selected: true,
              stale: true,
            },
          ],
        },
      })
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.detachConnection("account-1", "connection-1")
    })

    expect(result.current.view?.accounts[0]?.connections).toEqual([])
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: {
        kind: "detachConnection",
        accountId: "account-1",
        connectionId: "connection-1",
      },
    })
  })

  it("reports a friendly error when an account operation cannot run", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: null,
        accounts: [],
      })
      .mockRejectedValueOnce(new Error("ipc unavailable"))
    const { result } = renderHook(() => useProviderAccounts("cursor"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.refreshActive()
    })

    expect(result.current.error).toBe("账号操作失败，请重试")
    expect(result.current.busy).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("does not retain another provider's view when the provider changes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "account-1",
        accounts: [],
      })
      .mockRejectedValueOnce(new Error("codex view unavailable"))
    const { result, rerender } = renderHook(
      ({ providerId }) => useProviderAccounts(providerId),
      { initialProps: { providerId: "cursor" } }
    )
    await waitFor(() => expect(result.current.view?.providerId).toBe("cursor"))

    rerender({ providerId: "codex" })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.view).toBeNull()
    expect(result.current.error).toBe("无法加载账号")
    expect(errorSpy).toHaveBeenCalled()
  })

  it("ignores an operation result from the provider that was left", async () => {
    let resolveOperation!: (receipt: unknown) => void
    const operationPromise = new Promise((resolve) => {
      resolveOperation = resolve
    })
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "cursor-account",
        accounts: [],
      })
      .mockReturnValueOnce(operationPromise)
      .mockResolvedValueOnce({
        providerId: "codex",
        selection: { mode: "auto" },
        activeAccountId: "codex-account",
        accounts: [],
      })
    const { result, rerender } = renderHook(
      ({ providerId }) => useProviderAccounts(providerId),
      { initialProps: { providerId: "cursor" } }
    )
    await waitFor(() => expect(result.current.view?.providerId).toBe("cursor"))

    let pendingOperation!: Promise<unknown>
    act(() => {
      pendingOperation = result.current.refreshActive()
    })
    rerender({ providerId: "codex" })
    await waitFor(() => expect(result.current.view?.providerId).toBe("codex"))

    await act(async () => {
      resolveOperation({
        operationId: "old-operation",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "cursor-account",
          accounts: [],
        },
      })
      await pendingOperation
    })

    expect(result.current.view?.providerId).toBe("codex")
    expect(result.current.receipt).toBeNull()
  })

  it("does not revive an old operation after leaving and returning to a provider", async () => {
    let resolveOperation!: (receipt: unknown) => void
    const operationPromise = new Promise((resolve) => {
      resolveOperation = resolve
    })
    tauri.invoke
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "cursor-old",
        accounts: [],
      })
      .mockReturnValueOnce(operationPromise)
      .mockResolvedValueOnce({
        providerId: "codex",
        selection: { mode: "auto" },
        activeAccountId: "codex-account",
        accounts: [],
      })
      .mockResolvedValueOnce({
        providerId: "cursor",
        selection: { mode: "auto" },
        activeAccountId: "cursor-latest",
        accounts: [],
      })
    const { result, rerender } = renderHook(
      ({ providerId }) => useProviderAccounts(providerId),
      { initialProps: { providerId: "cursor" } }
    )
    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("cursor-old"))

    let pendingOperation!: Promise<unknown>
    act(() => {
      pendingOperation = result.current.refreshActive()
    })
    rerender({ providerId: "codex" })
    await waitFor(() => expect(result.current.view?.providerId).toBe("codex"))
    rerender({ providerId: "cursor" })
    await waitFor(() => expect(result.current.view?.activeAccountId).toBe("cursor-latest"))

    await act(async () => {
      resolveOperation({
        operationId: "old-operation",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "cursor-old",
          accounts: [],
        },
      })
      await pendingOperation
    })

    expect(result.current.view?.activeAccountId).toBe("cursor-latest")
    expect(result.current.receipt).toBeNull()
  })
})
