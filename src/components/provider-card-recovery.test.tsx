import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ProviderCard } from "@/components/provider-card"

describe("ProviderCard Recovery", () => {
  it("offers a visible retry after a failed refresh even during the last success cooldown", () => {
    const onRetry = vi.fn()
    render(
      <ProviderCard
        providerId="codex"
        name="Codex"
        displayMode="used"
        error="Session expired. Run `codex` to log in again."
        lastManualRefreshAt={Date.now() - 1_000}
        lastUpdatedAt={Date.now() - 1_000}
        lines={[{ type: "progress", label: "Session", used: 40, limit: 100, format: { kind: "percent" } }]}
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText("40%")).toBeInTheDocument()
    expect(screen.getByText("当前显示上次成功的数据。")).toBeVisible()
    const retry = screen.getByRole("button", { name: "重试" })
    expect(retry).toBeVisible()
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument()
  })

  it("keeps retry disabled while the provider is loading", () => {
    const onRetry = vi.fn()
    render(
      <ProviderCard name="Codex" displayMode="used" error="Network error" loading onRetry={onRetry} />,
    )
    const retry = screen.getByRole("button", { name: "正在重试" })
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(onRetry).not.toHaveBeenCalled()
  })
})
