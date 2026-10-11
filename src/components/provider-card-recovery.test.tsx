import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ProviderCard } from "@/components/provider-card"

describe("ProviderCard Recovery", () => {
  it("offers retry for a network failure during cooldown and labels cached data with its actual time", () => {
    const onRetry = vi.fn()
    const lastUpdatedAt = new Date("2026-10-11T03:15:00Z").getTime()
    render(<ProviderCard providerId="codex" name="Codex" displayMode="used" error="Network error" lastManualRefreshAt={Date.now() - 1_000} lastUpdatedAt={lastUpdatedAt} lines={[{ type: "progress", label: "Session", used: 40, limit: 100, format: { kind: "percent" } }]} onRetry={onRetry} />)
    expect(screen.getByText("已用 40%")).toBeInTheDocument()
    expect(screen.getByText(`上次数据 · ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument()
  })

  it.each([
    { providerId: "web", error: "No API key found", capabilities: { config: { fields: [{ id: "apiKey", type: "secret" as const, label: "API Key", options: [] }] } }, label: "连接账号", action: "config" },
    { providerId: "cursor", error: "Session expired", capabilities: { accountSupport: { localDiscovery: true, browserBinding: true, modelHistory: true } }, label: "重新连接", action: "accounts" },
    { providerId: "codex", error: "Session expired", capabilities: undefined, label: "连接本机账号", action: "local" },
  ])("routes both header and primary action to $action", ({ label, action, ...props }) => {
    const onRecovery = vi.fn(), onRetry = vi.fn()
    render(<ProviderCard {...props} name="Provider" displayMode="used" onRecovery={onRecovery} onRetry={onRetry} />)
    const buttons = screen.getAllByRole("button", { name: label })
    expect(buttons).toHaveLength(2)
    buttons.forEach((button) => fireEvent.click(button))
    expect(onRecovery).toHaveBeenCalledTimes(2)
    expect(onRecovery).toHaveBeenCalledWith(expect.objectContaining({ action }))
    expect(onRetry).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument()
  })

  it("keeps retry disabled while the provider is loading", () => {
    const onRetry = vi.fn()
    render(<ProviderCard name="Codex" displayMode="used" error="Network error" loading onRetry={onRetry} />)
    const retry = screen.getByRole("button", { name: "正在检查" })
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(onRetry).not.toHaveBeenCalled()
  })
})
