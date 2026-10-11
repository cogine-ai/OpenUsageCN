import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PluginError } from "@/components/plugin-error"

const config = { fields: [{ id: "apiKey", type: "secret" as const, label: "API Key", options: [] }, { id: "cookie", type: "secret" as const, label: "Cookie", options: [] }] }

describe("PluginError", () => {
  it("keeps unknown diagnostics behind a disclosure", () => {
    render(<PluginError message="Boom" />)
    expect(screen.getByText("暂时无法更新")).toBeVisible()
    expect(screen.getByText("Boom")).not.toBeVisible()
    fireEvent.click(screen.getByText("诊断详情"))
    expect(screen.getByText("Boom")).toBeVisible()
  })

  it("preserves exact diagnostic text inside the disclosure", () => {
    render(<PluginError message="Check `config.json` file" />)
    expect(screen.getByText("Check `config.json` file")).not.toBeVisible()
  })

  it("shows concise recovery and only reveals advice with diagnostics", () => {
    const onRetry = vi.fn()
    render(<PluginError message="Usage request failed (HTTP 429). Try again later." onRetry={onRetry} />)
    expect(screen.getByText("请求过于频繁")).toBeVisible()
    expect(screen.getByText("请稍后再重试，避免连续刷新。")).not.toBeVisible()
    expect(screen.getByText(/HTTP 429/)).not.toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it.each([
    { message: "No API key found", providerId: "bigmodel", capabilities: { config }, label: "连接账号", action: "config", focusField: "apiKey" },
    { message: "Session expired", providerId: "web", capabilities: { config }, label: "更新凭据", action: "config", focusField: "apiKey" },
    { message: "No cookie found", providerId: "web", capabilities: { config }, label: "连接账号", action: "config", focusField: "cookie" },
    { message: "Session expired", providerId: "cursor", capabilities: { accountSupport: { localDiscovery: true, browserBinding: true, modelHistory: true } }, label: "重新连接", action: "accounts", focusField: undefined },
    { message: "Not logged in", providerId: "codex", capabilities: undefined, label: "连接本机账号", action: "local", focusField: undefined },
    { message: "Credentials could not be read", providerId: "claude", capabilities: { accountSupport: { localDiscovery: true, browserBinding: true, modelHistory: true } }, label: "检查读取权限", action: "local", focusField: undefined },
  ])("opens $action recovery for $message", ({ message, providerId, capabilities, label, action, focusField }) => {
    const onRecovery = vi.fn(), onRetry = vi.fn()
    render(<PluginError {...{ message, providerId, capabilities, onRecovery, onRetry }} />)
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect(onRecovery).toHaveBeenCalledWith(expect.objectContaining({ action, focusField }))
    expect(onRetry).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument()
  })

  it("keeps the last successful timestamp visible while diagnostics are closed", () => {
    const lastUpdatedAt = new Date("2026-10-11T03:15:00Z").getTime()
    render(<PluginError message="Network error" hasStaleData lastUpdatedAt={lastUpdatedAt} onRetry={vi.fn()} />)
    expect(screen.getByText(`上次数据 · ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)).toBeVisible()
  })

  it("disables the actual action while a check is running", () => {
    const onRecovery = vi.fn()
    render(<PluginError message="No API key found" capabilities={{ config }} onRecovery={onRecovery} retrying />)
    const button = screen.getByRole("button", { name: "正在检查" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onRecovery).not.toHaveBeenCalled()
  })

  it("never makes an arbitrary error URL an action link or reveals credentials", () => {
    render(<PluginError message="Unexpected: https://untrusted.example/login?token=secret-value" />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(within(screen.getByRole("alert")).getByText(/https:\/\/untrusted.example\/login/)).not.toBeVisible()
    expect(document.body.textContent).not.toContain("secret-value")
  })
})
