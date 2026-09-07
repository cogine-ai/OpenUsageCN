import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { LocalUsageHistory } from "@/components/local-usage-history"
import { ProviderDetailPage } from "@/pages/provider-detail"

describe("LocalUsageHistory", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("loads local history separately while the real detail quota stays visible", async () => {
    let resolveHistory!: (value: unknown) => void
    const pending = new Promise((resolve) => { resolveHistory = resolve })
    tauri.invoke.mockImplementation((command) => {
      if (command === "get_platform_capabilities") return Promise.resolve({ platform: "macos" })
      if (command === "refresh_local_history") return pending
      throw new Error(`Unexpected command ${command}`)
    })
    const refreshQuota = vi.fn()
    render(<ProviderDetailPage plugin={{
      meta: { id: "codex", name: "Codex", iconUrl: "", lines: [] },
      data: { providerId: "codex", displayName: "Codex", iconUrl: "", lines: [
        { type: "progress", label: "5小时", used: 35, limit: 100, format: { kind: "percent" } },
      ] },
      loading: false, error: null, lastUpdatedAt: 1_788_732_000_000, lastManualRefreshAt: null,
    }} onRetry={refreshQuota} displayMode="used" resetTimerDisplayMode="relative" />)
    await userEvent.click(await screen.findByRole("button", { name: "Load Local History" }))
    expect(screen.getByText("5小时")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("额度仍可正常刷新")
    expect(screen.queryByText("今日")).not.toBeInTheDocument()
    await act(async () => {
      resolveHistory({ providerId: "codex", accountId: null, fetchedAt: "2026-09-07T01:00:00Z",
        lines: [{ type: "text", label: "今日", value: "$1.20 · 240K tokens" }] })
      await pending
    })
    expect(await screen.findByText("今日")).toBeInTheDocument()
    expect(screen.getByText("5小时")).toBeInTheDocument()
    expect(refreshQuota).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Refresh Local History" })).toBeInTheDocument()
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "refresh_local_history")).toHaveLength(1)
  })

  it("does not offer local history on Windows", async () => {
    tauri.invoke.mockResolvedValue({ platform: "windows" })
    render(<LocalUsageHistory providerId="codex" />)
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("get_platform_capabilities"))
    expect(screen.queryByRole("button", { name: "Load Local History" })).not.toBeInTheDocument()
    expect(tauri.invoke).not.toHaveBeenCalledWith("refresh_local_history", expect.anything())
  })
})
