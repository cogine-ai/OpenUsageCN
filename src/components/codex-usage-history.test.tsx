import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { CodexUsageHistory } from "./codex-usage-history"

const localSnapshot = { providerId: "codex", accountId: null, fetchedAt: "2026-11-07T00:00:00Z",
  lines: [{ type: "text", label: "今日", value: "$1.20 · 240K tokens" }] }

describe("CodexUsageHistory", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.invoke.mockImplementation((command) => Promise.resolve(command === "get_platform_capabilities" ? { platform: "macos" } : command === "refresh_local_history" ? localSnapshot : null))
  })

  it("starts with official statistics and loads neither source merely by opening or switching", async () => {
    render(<CodexUsageHistory sourceRefreshing={false} lastUpdatedAt={1} />)
    expect(screen.getByRole("tab", { name: "官方统计" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("button", { name: "加载官方统计" })).toBeEnabled()
    fireEvent.click(await screen.findByRole("tab", { name: "本机估算" }))
    expect(await screen.findByText("最近 31 天")).toBeVisible()
    expect(screen.getByRole("button", { name: "Load Local History" })).toHaveTextContent("加载本机估算")
    expect(tauri.invoke.mock.calls.every(([command]) => command === "get_platform_capabilities")).toBe(true)
  })

  it("cancels the exact official request on source switch and rejects its late result", async () => {
    let finish!: (value: unknown) => void
    tauri.invoke.mockImplementation((command) => command === "get_platform_capabilities" ? Promise.resolve({ platform: "macos" })
      : command === "refresh_provider_reports" ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(null))
    render(<CodexUsageHistory sourceRefreshing={false} lastUpdatedAt={1} />)
    fireEvent.click(screen.getByRole("button", { name: "加载官方统计" }))
    const args = tauri.invoke.mock.calls.find(([command]) => command === "refresh_provider_reports")![1]
    fireEvent.click(await screen.findByRole("tab", { name: "本机估算" }))
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", args)
    await act(async () => { finish({ ...args, scopeKey: "a".repeat(64), fetchedAt: "2026-11-07T00:00:00Z", reports: [], lines: [{ type: "text", label: "Private Report", value: "Old Account" }] }) })
    expect(screen.queryByText("Old Account")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "官方统计" }))
    expect(screen.queryByText("Old Account")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "加载官方统计" })).toBeEnabled()
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "refresh_provider_reports")).toHaveLength(1)
  })

  it("keeps the current local estimate through quota refresh, but clears it when changing sources", async () => {
    const { rerender } = render(<CodexUsageHistory sourceRefreshing={false} lastUpdatedAt={1} />)
    fireEvent.click(await screen.findByRole("tab", { name: "本机估算" }))
    fireEvent.click(await screen.findByRole("button", { name: "Load Local History" }))
    expect(await screen.findByText("$1.20 · 240K tokens")).toBeVisible()
    rerender(<CodexUsageHistory sourceRefreshing lastUpdatedAt={1} />)
    expect(screen.getByText("$1.20 · 240K tokens")).toBeVisible()
    rerender(<CodexUsageHistory sourceRefreshing={false} lastUpdatedAt={2} />)
    expect(screen.getByText("$1.20 · 240K tokens")).toBeVisible()
    fireEvent.click(screen.getByRole("tab", { name: "官方统计" }))
    fireEvent.click(screen.getByRole("tab", { name: "本机估算" }))
    expect(screen.queryByText("$1.20 · 240K tokens")).not.toBeInTheDocument()
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "refresh_local_history")).toHaveLength(1)
  })

  it("offers only official statistics on Windows", async () => {
    tauri.invoke.mockResolvedValue({ platform: "windows" })
    render(<CodexUsageHistory sourceRefreshing={false} lastUpdatedAt={1} />)
    await act(async () => {})
    expect(screen.getByRole("tab", { name: "官方统计" })).toBeVisible()
    expect(screen.queryByRole("tab", { name: "本机估算" })).not.toBeInTheDocument()
    expect(tauri.invoke.mock.calls.every(([command]) => command === "get_platform_capabilities")).toBe(true)
  })

  it("discards a pending local estimate after switching to official statistics", async () => {
    let finish!: (value: unknown) => void
    tauri.invoke.mockImplementation((command) => command === "get_platform_capabilities" ? Promise.resolve({ platform: "macos" })
      : command === "refresh_local_history" ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(null))
    render(<CodexUsageHistory sourceRefreshing={false} lastUpdatedAt={1} />)
    fireEvent.click(await screen.findByRole("tab", { name: "本机估算" }))
    fireEvent.click(await screen.findByRole("button", { name: "Load Local History" }))
    fireEvent.click(screen.getByRole("tab", { name: "官方统计" }))
    await act(async () => { finish(localSnapshot) })
    expect(screen.queryByText("$1.20 · 240K tokens")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "本机估算" }))
    expect(await screen.findByRole("button", { name: "Load Local History" })).toBeEnabled()
    expect(screen.queryByText("$1.20 · 240K tokens")).not.toBeInTheDocument()
  })
})
