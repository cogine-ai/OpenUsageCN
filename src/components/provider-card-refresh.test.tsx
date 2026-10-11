import { fireEvent, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openUrl } from "@tauri-apps/plugin-opener"
import { ProviderCard } from "@/components/provider-card"
import { groupLinesByType } from "@/lib/group-lines-by-type"
import { formatResetTooltipText } from "@/lib/reset-tooltip"
import { REFRESH_COOLDOWN_MS } from "@/lib/settings"
import { formatFixedPrecisionNumber } from "@/lib/utils"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({
    children,
    render,
    ...props
  }: {
    children: ReactNode
    render?: ((props: Record<string, unknown>) => ReactNode) | ReactNode
  }) => {
    if (typeof render === "function") {
      return render({ ...props, children })
    }
    if (render) return render
    return <div {...props}>{children}</div>
  },
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

function formatMonthDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date)
}

describe("ProviderCard", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.mocked(openUrl).mockClear()
  })

  it("renders error state with retry", async () => {
    const onRetry = vi.fn()
    render(
      <ProviderCard
        name="Test"
        displayMode="used"
        error="Nope"
        onRetry={onRetry}
      />
    )
    expect(screen.getByText("Nope")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "刷新" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("renders loading skeleton", () => {
    render(
      <ProviderCard
        name="Test"
        displayMode="used"
        loading
        skeletonLines={[
          { type: "text", label: "One", scope: "overview" },
          { type: "badge", label: "Two", scope: "overview" },
        ]}
      />
    )
    expect(screen.getByText("One")).toBeInTheDocument()
    expect(screen.getByText("Two")).toBeInTheDocument()
  })

  it("shows loading spinner when retry is enabled", () => {
    const { container } = render(
      <ProviderCard
        name="Loading"
        displayMode="used"
        loading
        onRetry={() => {}}
      />
    )
    expect(container.querySelector("svg.animate-spin")).toBeTruthy()
  })

  it("shows cooldown hint", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:00:00.000Z")
    vi.setSystemTime(now)
    const lastManualRefreshAt = now.getTime() - (REFRESH_COOLDOWN_MS - 65_000)
    render(
      <ProviderCard
        name="Cooldown"
        displayMode="used"
        lastManualRefreshAt={lastManualRefreshAt}
        onRetry={() => {}}
      />
    )
    expect(screen.getByText("1 分 5 秒后可刷新")).toBeInTheDocument()
  })

  it("shows seconds-only cooldown", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:00:00.000Z")
    vi.setSystemTime(now)
    const lastManualRefreshAt = now.getTime() - (REFRESH_COOLDOWN_MS - 30_000)
    render(
      <ProviderCard
        name="Cooldown"
        displayMode="used"
        lastManualRefreshAt={lastManualRefreshAt}
        onRetry={() => {}}
      />
    )
    expect(screen.getByText("30 秒后可刷新")).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("fires retry from header button", () => {
    const onRetry = vi.fn()
    const { container } = render(
      <ProviderCard
        name="Retry"
        displayMode="used"
        onRetry={onRetry}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    const buttons = Array.from(container.querySelectorAll("button"))
    const iconButton = buttons.find((button) => button.textContent === "")
    expect(iconButton).toBeTruthy()
    if (iconButton) {
      iconButton.focus()
      iconButton.click()
    }
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("renders refresh button when cooldown expired", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:00:00.000Z")
    vi.setSystemTime(now)
    const lastManualRefreshAt = now.getTime() - (REFRESH_COOLDOWN_MS + 1000)
    const onRetry = vi.fn()
    const { container } = render(
      <ProviderCard
        name="Retry"
        displayMode="used"
        onRetry={onRetry}
        lastManualRefreshAt={lastManualRefreshAt}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    const buttons = Array.from(container.querySelectorAll("button"))
    const iconButton = buttons.find((button) => button.textContent === "")
    expect(iconButton).toBeTruthy()
    iconButton?.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it("cleans up cooldown timers on unmount", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:00:00.000Z")
    vi.setSystemTime(now)
    const lastManualRefreshAt = now.getTime() - (REFRESH_COOLDOWN_MS - 1000)
    const clearIntervalSpy = vi.spyOn(global, "clearInterval")
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout")
    const { unmount } = render(
      <ProviderCard
        name="Cooldown"
        displayMode="used"
        lastManualRefreshAt={lastManualRefreshAt}
        onRetry={() => {}}
      />
    )
    unmount()
    expect(clearIntervalSpy).toHaveBeenCalled()
    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
    clearTimeoutSpy.mockRestore()
    vi.useRealTimers()
  })

  it("filters skeleton lines during loading", () => {
    render(
      <ProviderCard
        name="Loading"
        displayMode="used"
        loading
        scopeFilter="overview"
        skeletonLines={[
          { type: "progress", label: "Session", scope: "overview" },
          { type: "progress", label: "Extra", scope: "detail" },
        ]}
      />
    )
    expect(screen.getByText("Session")).toBeInTheDocument()
    expect(screen.queryByText("Extra")).not.toBeInTheDocument()
  })

  it("keeps stale data visible while loading (stale-while-revalidate)", () => {
    render(
      <ProviderCard
        name="SWR"
        displayMode="used"
        loading
        lastUpdatedAt={Date.now() - 60_000}
        lines={[
          { type: "text", label: "Label", value: "Value" },
          { type: "progress", label: "Session", used: 32, limit: 100, format: { kind: "percent" } },
        ]}
        skeletonLines={[
          { type: "text", label: "Label", scope: "overview" },
          { type: "progress", label: "Session", scope: "overview" },
        ]}
      />
    )
    // Real data stays on screen — no skeleton swap
    expect(screen.getByText("Value")).toBeInTheDocument()
    expect(screen.getByText("已用 32%")).toBeInTheDocument()
    // Progress bar shows shimmer overlay
    expect(document.querySelector('[data-slot="progress-refreshing"]')).toBeTruthy()
  })

  it("skips skeleton on refresh when lastUpdatedAt set even if filtered lines are empty", () => {
    render(
      <ProviderCard
        name="FilteredEmpty"
        displayMode="used"
        loading
        lastUpdatedAt={Date.now() - 60_000}
        scopeFilter="overview"
        skeletonLines={[
          { type: "progress", label: "Session", scope: "overview" },
        ]}
        lines={[
          { type: "text", label: "DetailOnly", value: "Hidden" },
        ]}
      />
    )
    // skeleton label for "Session" should not render because we have prior data (lastUpdatedAt set)
    expect(screen.queryByText("Session")).toBeNull()
    // and the detail-scoped line stays filtered out
    expect(screen.queryByText("DetailOnly")).toBeNull()
  })

  it("renders skeleton on first load when no stale data exists", () => {
    render(
      <ProviderCard
        name="Cold"
        displayMode="used"
        loading
        skeletonLines={[{ type: "progress", label: "Session", scope: "overview" }]}
      />
    )
    expect(screen.getByText("Session")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="progress-refreshing"]')).toBeNull()
  })

  it("shows recovery details with stale data on refresh error", () => {
    render(
      <ProviderCard
        name="StaleErr"
        displayMode="used"
        error="Couldn't update data. Try again?"
        lastUpdatedAt={Date.now() - 60_000}
        lines={[
          { type: "progress", label: "Session", used: 40, limit: 100, format: { kind: "percent" } },
        ]}
      />
    )
    // Stale data still visible
    expect(screen.getByText("已用 40%")).toBeInTheDocument()
    expect(screen.getByText("Couldn't update data. Try again?")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("shows full PluginError when errored without stale data", () => {
    render(
      <ProviderCard
        name="ColdErr"
        displayMode="used"
        error="Nope"
        onRetry={() => {}}
      />
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("Nope")).toBeInTheDocument()
  })

  it("shows relative last-updated timestamp in retry tooltip", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:05:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Updated"
        displayMode="used"
        onRetry={() => {}}
        lastUpdatedAt={now.getTime() - 120_000}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    expect(screen.getByText(/2 分钟前更新/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("shows '刚刚' for very recent last-updated timestamps", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:05:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Fresh"
        displayMode="used"
        onRetry={() => {}}
        lastUpdatedAt={now.getTime() - 5_000}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    expect(screen.getByText(/刚刚更新/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("clamps negative time deltas to 'just now' (clock skew)", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:05:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Skew"
        displayMode="used"
        onRetry={() => {}}
        lastUpdatedAt={now.getTime() + 60_000}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    expect(screen.getByText(/刚刚更新/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("omits retry tooltip content when lastUpdatedAt is null", () => {
    render(
      <ProviderCard
        name="NoTimestamp"
        displayMode="used"
        onRetry={() => {}}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    expect(screen.queryByText(/更新/)).toBeNull()
  })
})
