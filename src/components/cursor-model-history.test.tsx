import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CompleteHistory } from "@/lib/cursor-history"
import fixtures from "./__fixtures__/cursor-history.json"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { CursorModelUsage } from "./cursor-model-usage"

function recorded() { return structuredClone(fixtures) as CompleteHistory[] }
function setup(history = recorded()) {
  tauri.invoke.mockImplementation((command: string) => {
    if (command === "get_cursor_history_snapshot") return Promise.resolve(history[0])
    if (command === "refresh_cursor_history") return Promise.resolve({ snapshot: history[0], stale: false })
    if (command === "list_cursor_history_snapshots") return Promise.resolve(history)
    if (command === "export_cursor_history_csv") return Promise.resolve("/Downloads/cursor-history-123.csv")
    return Promise.reject(new Error("Unexpected command"))
  })
  return render(<CursorModelUsage providerId="cursor" accountId="cursor-demo-account" />)
}

describe("Cursor recorded windows", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("compares equally covered windows and reads historical selection without fetching again", async () => {
    setup()
    expect(await screen.findAllByText("+100.0%")).toHaveLength(3)
    const before = tauri.invoke.mock.calls.filter(([command]) => command === "refresh_cursor_history").length
    fireEvent.change(screen.getByRole("combobox", { name: "Recorded Windows" }), {
      target: { value: `${fixtures[1].coverage.fromMs}:${fixtures[1].coverage.toMs}:${fixtures[1].coverage.fetchedAtMs}` },
    })
    expect(await screen.findByRole("heading", { name: "claude-sonnet-4.5" })).toBeInTheDocument()
    expect(screen.getByText("Stored Window")).toBeInTheDocument()
    expect(screen.getByText("Cannot Compare")).toBeInTheDocument()
    expect(screen.queryByText("+100.0%")).not.toBeInTheDocument()
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "refresh_cursor_history")).toHaveLength(before)
    expect(screen.getByText(/分页完整仅表示/)).toBeInTheDocument()
  })

  it("omits percentages for incomplete cost meanings and a zero baseline", async () => {
    const history = recorded()
    history[0].buckets[0].listCostCoverage = "partial"
    history[1].totals.meteredChargedUsd = 0
    setup(history)
    const table = await screen.findByRole("table")
    expect(within(table).getAllByText("+100.0%")).toHaveLength(1)
    expect(within(table).getAllByText("—")).toHaveLength(2)
  })

  it("exports the chosen stored window and shows its actual destination", async () => {
    setup()
    const button = await screen.findByRole("button", { name: "Export CSV" })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByRole("status")).toHaveTextContent("/Downloads/cursor-history-123.csv")
    const { fromMs, toMs, fetchedAtMs } = fixtures[0].coverage
    expect(tauri.invoke).toHaveBeenCalledWith("export_cursor_history_csv", {
      providerId: "cursor", accountId: "cursor-demo-account", snapshot: { fromMs, toMs, fetchedAtMs },
    })
  })

  it("reports export failure without claiming a file was saved", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    setup()
    const button = await screen.findByRole("button", { name: "Export CSV" })
    await waitFor(() => expect(button).toBeEnabled())
    tauri.invoke.mockRejectedValueOnce({ code: "historyExportFailed" })
    fireEvent.click(button)
    expect(await screen.findByRole("alert")).toHaveTextContent("导出失败")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(errorLog).toHaveBeenCalledWith("Failed to export stored Cursor window")
    errorLog.mockRestore()
  })

  it("keeps current usage visible and reports an unreadable archive", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const history = recorded()
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_cursor_history_snapshot") return Promise.resolve(history[0])
      if (command === "refresh_cursor_history") return Promise.resolve({ snapshot: history[0], stale: false })
      return Promise.reject({ code: "historyStorageFailed" })
    })
    render(<CursorModelUsage providerId="cursor" accountId="cursor-demo-account" />)
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取已记录窗口")
    expect(screen.getByRole("heading", { name: "gpt-5" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled()
    expect(errorLog).toHaveBeenCalledWith("Failed to load recorded Cursor windows")
    errorLog.mockRestore()
  })

  it("ignores a late archive result after switching accounts", async () => {
    const history = recorded()
    const second = { ...history[0], accountId: "account-b", buckets: [{ ...history[0].buckets[0], modelName: "second-account-model" }] }
    let resolveOld: (value: CompleteHistory[]) => void = () => {}
    const oldArchive = new Promise<CompleteHistory[]>((resolve) => { resolveOld = resolve })
    tauri.invoke.mockImplementation((command: string, args: { accountId: string }) => {
      const snapshot = args.accountId === "account-b" ? second : history[0]
      if (command === "get_cursor_history_snapshot") return Promise.resolve(snapshot)
      if (command === "refresh_cursor_history") return Promise.resolve({ snapshot, stale: false })
      return args.accountId === "account-b" ? Promise.resolve([second]) : oldArchive
    })
    const view = render(<CursorModelUsage providerId="cursor" accountId="cursor-demo-account" />)
    await screen.findByRole("heading", { name: "gpt-5" })
    view.rerender(<CursorModelUsage providerId="cursor" accountId="account-b" />)
    await screen.findByRole("heading", { name: "second-account-model" })
    await act(async () => { resolveOld(history) })
    expect(screen.queryByRole("heading", { name: "gpt-5" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(1)
  })
})
