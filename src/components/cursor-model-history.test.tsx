import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    if (command === "export_cursor_history_csv") return Promise.resolve("/Downloads/cursor-history-123.csv")
    return Promise.reject(new Error("Unexpected command"))
  })
  return render(<CursorModelUsage providerId="cursor" accountId="cursor-demo-account" />)
}

describe("Cursor latest usage cache", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("shows actual coverage with no archive selector or comparisons", async () => {
    setup()
    await screen.findByRole("heading", { name: "gpt-5" })
    expect(screen.getByLabelText("Usage Coverage")).toHaveTextContent("–")
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(tauri.invoke.mock.calls.some(([command]) => command === "list_cursor_history_snapshots")).toBe(false)
  })

  it("exports the current cached snapshot and shows its actual destination", async () => {
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
    expect(errorLog).toHaveBeenCalledWith("Failed to export current Cursor usage")
    errorLog.mockRestore()
  })

  it("ignores a late export result after switching accounts", async () => {
    const history = recorded()
    let resolveExport: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => { resolveExport = resolve })
    tauri.invoke.mockImplementation((command: string, args: { accountId: string }) => {
      const snapshot = { ...history[0], accountId: args.accountId }
      if (command === "get_cursor_history_snapshot") return Promise.resolve(snapshot)
      if (command === "refresh_cursor_history") return Promise.resolve({ snapshot, stale: false })
      if (command === "export_cursor_history_csv") return pending
      throw new Error("Unexpected command")
    })
    const view = render(<CursorModelUsage providerId="cursor" accountId="cursor-demo-account" />)
    const button = await screen.findByRole("button", { name: "Export CSV" })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled()
    view.rerender(<CursorModelUsage providerId="cursor" accountId="account-b" />)
    await screen.findByRole("button", { name: "Export CSV" })
    await act(async () => { resolveExport("/Downloads/old-account.csv") })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})
