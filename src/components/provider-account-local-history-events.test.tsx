import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LocalHistorySnapshot } from "@/lib/local-history"
import type { ProviderAccountOperationReceipt, ProviderAccountView } from "@/lib/plugin-types"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listener: null as null | ((event: { payload: unknown }) => void),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))

import { ProviderAccountControls } from "@/components/provider-account-controls"

function accountView(connectionId = "cli-a", label = "Account A"): ProviderAccountView {
  return {
    providerId: "claude",
    selection: { mode: "pinned", accountId: "account-a" },
    activeAccountId: "account-a",
    accounts: [{
      accountId: "account-a", label, connectionKinds: ["cli"],
      connections: [{ connectionId, kind: "cli", available: true }],
      selected: true, stale: false,
    }],
  }
}

function history(): LocalHistorySnapshot {
  return {
    providerId: "claude", accountId: "account-a", fetchedAt: "2026-09-07T00:00:00Z",
    lines: [{ type: "text", label: "Today", value: "12K tokens" }],
  }
}

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("Claude local history during account view updates", () => {
  let view: ProviderAccountView
  let loadHistory: () => Promise<LocalHistorySnapshot>
  let operation: Promise<ProviderAccountOperationReceipt>

  beforeEach(() => {
    view = accountView()
    loadHistory = () => Promise.resolve(history())
    operation = Promise.resolve({ operationId: "refresh", status: "succeeded", sourceOutcomes: [], view })
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listener = null
    tauri.listen.mockImplementation(async (_name, listener) => {
      tauri.listener = listener
      return vi.fn()
    })
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_provider_account_view") return Promise.resolve(view)
      if (command === "get_platform_capabilities") return Promise.resolve({ platform: "macos" })
      if (command === "refresh_local_history") return loadHistory()
      if (command === "perform_provider_account_operation") return operation
      throw new Error(`Unexpected command: ${command}`)
    })
  })

  async function startHistory() {
    render(<ProviderAccountControls providerId="claude" />)
    fireEvent.click(await screen.findByRole("button", { name: "Load Local History" }))
  }

  async function publishView(nextView: ProviderAccountView) {
    view = nextView
    act(() => { tauri.listener?.({ payload: { providerId: "claude", revision: 1 } }) })
    await screen.findByText(nextView.accounts[0].label)
    await waitFor(() => expect(
      tauri.invoke.mock.calls.filter(([command]) => command === "get_provider_account_view")
    ).toHaveLength(2))
  }

  it("retains loaded history after an ordinary same-account quota event", async () => {
    await startHistory()
    expect(await screen.findByText("12K tokens")).toBeInTheDocument()

    await publishView(accountView("cli-a", "Account A Updated"))

    expect(screen.getByText("12K tokens")).toBeInTheDocument()
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "refresh_local_history")).toHaveLength(1)
  })

  it("accepts pending history after an ordinary same-account quota event", async () => {
    const request = pending<LocalHistorySnapshot>()
    loadHistory = () => request.promise
    await startHistory()

    await publishView(accountView("cli-a", "Account A Updated"))
    await act(async () => { request.resolve(history()); await request.promise })

    expect(await screen.findByText("12K tokens")).toBeInTheDocument()
  })

  it("retains history while refreshing the same account and disables concurrent history loads", async () => {
    const refresh = pending<ProviderAccountOperationReceipt>()
    operation = refresh.promise
    await startHistory()
    expect(await screen.findByText("12K tokens")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "账号" }))
    fireEvent.click(screen.getByRole("button", { name: "刷新账号" }))

    expect(screen.getByText("12K tokens")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh Local History" })).toBeDisabled()
    await act(async () => {
      refresh.resolve({ operationId: "refresh", status: "succeeded", sourceOutcomes: [], view })
      await refresh.promise
    })
    expect(screen.getByText("12K tokens")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh Local History" })).toBeEnabled()
  })

  it("clears loaded history when the CLI connection is replaced", async () => {
    await startHistory()
    expect(await screen.findByText("12K tokens")).toBeInTheDocument()

    await publishView(accountView("cli-b", "Replacement Connection"))

    expect(screen.queryByText("12K tokens")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Local History" })).toBeEnabled()
  })

  it("discards a pending result from the replaced CLI connection", async () => {
    const request = pending<LocalHistorySnapshot>()
    loadHistory = () => request.promise
    await startHistory()

    await publishView(accountView("cli-b", "Replacement Connection"))
    await act(async () => { request.resolve(history()); await request.promise })

    expect(screen.queryByText("12K tokens")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Local History" })).toBeEnabled()
  })
})
