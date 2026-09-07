import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PluginError } from "@/components/plugin-error"

describe("PluginError", () => {
  it("renders message", () => {
    render(<PluginError message="Boom" />)
    expect(screen.getByText("Boom")).toBeInTheDocument()
  })

  it("formats backtick code in message", () => {
    render(<PluginError message="Check `config.json` file" />)
    expect(screen.getByText("config.json")).toBeInTheDocument()
  })

  it("shows friendly recovery, expandable diagnostics and an explicit retry", () => {
    const onRetry = vi.fn()
    render(<PluginError message="Usage request failed (HTTP 429). Try again later." onRetry={onRetry} />)
    expect(screen.getByText("请求过于频繁")).toBeVisible()
    expect(screen.getByText("请稍后再重试，避免连续刷新。")).toBeVisible()
    expect(screen.getByText("诊断详情")).toBeVisible()
    expect(screen.getByText(/HTTP 429/)).not.toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("never makes an arbitrary error URL an action link", () => {
    render(<PluginError message="Unexpected: https://untrusted.example/login?token=secret-value" />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText(/https:\/\/untrusted.example\/login/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("secret-value")
  })
})
