import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginDisplayState } from "@/lib/plugin-types"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
vi.mock("@/components/local-usage-history", () => ({ LocalUsageHistory: () => null }))
import { ProviderDetailPage } from "./provider-detail"

function state(providerId = "codex", overrides: Partial<PluginDisplayState> = {}): PluginDisplayState {
  return {
    meta: { id: providerId, name: providerId, iconUrl: "", lines: [] },
    data: { providerId, displayName: providerId, iconUrl: "", lines: [{ type: "text", label: "Account", value: "Quota Account" }] },
    loading: false, error: null, lastUpdatedAt: 1, lastManualRefreshAt: null, ...overrides,
  }
}
function page(plugin: PluginDisplayState) {
  return <ProviderDetailPage plugin={plugin} displayMode="used" resetTimerDisplayMode="relative" />
}
function report(args: { providerId: string; requestId: string }, account = "A") {
  return { ...args, scopeKey: account.toLowerCase().repeat(64), fetchedAt: "2026-11-04T00:00:00Z",
    lines: [{ type: "text", label: args.providerId === "ollama" ? "7D Requests" : "Reported Tokens", value: account + " Report" }],
    reports: [{ id: args.providerId === "ollama" ? "7d" : "counts", label: "Tokens And Turns", status: "ready" }] }
}

describe("provider report account isolation during quota refresh", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockResolvedValue(vi.fn())
    tauri.invoke.mockImplementation((command, args) => Promise.resolve(command === "get_ollama_accounts" ? { revision: 0, primary: { mode: "legacy" }, connections: [], legacy: { source: "apiKey", configured: true, revision: 0 } } : command === "refresh_provider_reports" ? report(args) : null))
  })

  it.each(["codex", "ollama", "openrouter"])("clears loaded %s reports when quota refresh starts and requires a new load", async (providerId) => {
    const { rerender } = render(page(state(providerId)))
    if (providerId === "ollama") fireEvent.click(await screen.findByRole("button", { name: "查看原有连接用量" }))
    fireEvent.click(await screen.findByRole("button", { name: "Load Reports" }))
    expect(await screen.findByText("A Report")).toBeVisible()
    rerender(page(state(providerId, { loading: true })))
    expect(screen.queryByText("A Report")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeDisabled()
    rerender(page(state(providerId, { lastUpdatedAt: 2 })))
    expect(screen.queryByText("A Report")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
    tauri.invoke.mockImplementation((command, args) => Promise.resolve(command === "refresh_provider_reports" ? report(args, "B") : null))
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    expect(await screen.findByText("B Report")).toBeVisible()
  })

  it("cancels the exact pending report and rejects a late response after quota refresh", async () => {
    let finish: (value: unknown) => void = () => {}
    tauri.invoke.mockImplementation((command) => command === "refresh_provider_reports" ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(null))
    const { rerender } = render(page(state()))
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    const args = tauri.invoke.mock.calls.find(([command]) => command === "refresh_provider_reports")![1]
    rerender(page(state("codex", { loading: true })))
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", args)
    rerender(page(state("codex", { lastUpdatedAt: 2 })))
    await act(async () => { finish(report(args)) })
    expect(screen.queryByText("A Report")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
  })

  it("invalidates a loaded report when a new quota result arrives without a loading render", async () => {
    const { rerender } = render(page(state()))
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    await screen.findByText("A Report")
    rerender(page(state("codex", { lastUpdatedAt: 2 })))
    expect(screen.queryByText("A Report")).not.toBeInTheDocument()
  })

  it("does not restore an old report when the quota refresh fails", async () => {
    const { rerender } = render(page(state()))
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    await screen.findByText("A Report")
    rerender(page(state("codex", { loading: true })))
    rerender(page(state("codex", { error: "Network error" })))
    expect(screen.queryByText("A Report")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
  })
})
