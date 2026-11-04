import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import type { PluginDisplayState } from "@/lib/plugin-types"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { ProviderDetailPage } from "./provider-detail"

const accounts = {
  revision: 1,
  primary: { mode: "connection", connectionId: "home" },
  connections: ["home", "work"].map((id) => ({
    connectionId: id,
    label: id === "home" ? "个人账号" : "工作账号",
    identity: { name: `@${id}` },
    keyHint: "8F2A",
    revision: 1,
    lastUpdatedAt: "2026-11-05T00:00:00Z",
    snapshot: { providerId: "ollama", displayName: "Ollama Cloud", iconUrl: "", lines: [] },
  })),
}

function page(loading = false, error: string | null = null) {
  const plugin: PluginDisplayState = {
    meta: { id: "ollama", name: "Ollama Cloud", iconUrl: "", lines: [], primaryCandidates: [] },
    data: { providerId: "ollama", displayName: "Ollama Cloud", iconUrl: "", lines: [] },
    loading,
    error,
    lastUpdatedAt: 1,
    lastManualRefreshAt: null,
  }
  return <ProviderDetailPage plugin={plugin} displayMode="used" resetTimerDisplayMode="relative" />
}

function report(args: { providerId: string; requestId: string; connectionId: string }) {
  return {
    ...args,
    scopeKey: (args.connectionId === "home" ? "a" : "b").repeat(64),
    fetchedAt: "2026-11-05T00:00:00Z",
    lines: [{ type: "text", label: "7D Requests", value: `${args.connectionId} Report` }],
    reports: [{ id: "7d", label: "7D Model Usage", status: "ready" }],
  }
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockResolvedValue(vi.fn())
  tauri.invoke.mockImplementation((command, args) =>
    Promise.resolve(command === "get_ollama_accounts" ? accounts : command === "refresh_provider_reports" ? report(args) : null)
  )
})

it("clears a viewed primary report on app quota refresh and does not restore it after failure", async () => {
  const { rerender } = render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看个人账号用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports", exact: true }))
  await screen.findByText("home Report")

  rerender(page(true))
  expect(screen.queryByText("home Report")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Load Reports", exact: true })).toBeDisabled()
  rerender(page(false, "Network error"))
  expect(screen.queryByText("home Report")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Load Reports", exact: true })).toBeEnabled()
  expect(tauri.invoke.mock.calls.filter(([command]) => command === "refresh_provider_reports")).toHaveLength(1)
})

it("cancels a pending primary report and discards its late response across app refresh failure", async () => {
  let finish: (value: unknown) => void = () => {}
  tauri.invoke.mockImplementation((command) =>
    command === "get_ollama_accounts"
      ? Promise.resolve(accounts)
      : command === "refresh_provider_reports"
        ? new Promise((resolve) => { finish = resolve })
        : Promise.resolve(null)
  )
  const { rerender } = render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看个人账号用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports", exact: true }))
  const args = tauri.invoke.mock.calls.find(([command]) => command === "refresh_provider_reports")![1]
  rerender(page(true))
  expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", {
    providerId: "ollama", requestId: args.requestId,
  })
  expect(screen.getByRole("button", { name: "Load Reports", exact: true })).toBeDisabled()
  rerender(page(false, "Network error"))
  await act(async () => finish(report(args)))
  expect(screen.queryByText("home Report")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Load Reports", exact: true })).toBeEnabled()
})

it("preserves a non-primary account's loaded report while the primary refreshes", async () => {
  const { rerender } = render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看工作账号用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports", exact: true }))
  await screen.findByText("work Report")
  rerender(page(true))
  expect(screen.getByText("work Report")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Refresh Reports", exact: true })).toBeEnabled()
  rerender(page(false, "Network error"))
  expect(screen.getByText("work Report")).toBeInTheDocument()
})

it("allows a non-primary report to finish while the primary refreshes", async () => {
  let finish: (value: unknown) => void = () => {}
  tauri.invoke.mockImplementation((command) =>
    command === "get_ollama_accounts"
      ? Promise.resolve(accounts)
      : command === "refresh_provider_reports"
        ? new Promise((resolve) => { finish = resolve })
        : Promise.resolve(null)
  )
  const { rerender } = render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看工作账号用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports", exact: true }))
  const args = tauri.invoke.mock.calls.find(([command]) => command === "refresh_provider_reports")![1]
  rerender(page(true))
  expect(tauri.invoke).not.toHaveBeenCalledWith("cancel_provider_reports", expect.anything())
  await act(async () => finish(report(args)))
  expect(screen.getByText("work Report")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Refresh Reports", exact: true })).toBeEnabled()
})
