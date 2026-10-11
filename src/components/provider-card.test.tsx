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

  it("renders metric lines + progress formats", () => {
    render(
      <ProviderCard
        name="Metrics"
        displayMode="used"
        lines={[
          { type: "text", label: "Label", value: "Value" },
          { type: "badge", label: "Plan", text: "Pro" },
          { type: "progress", label: "Percent", used: 32.4, limit: 100, format: { kind: "percent" } },
          { type: "progress", label: "Dollars", used: 12.34, limit: 100, format: { kind: "dollars" } },
          { type: "progress", label: "Credits", used: 342, limit: 1000, format: { kind: "count", suffix: "credits" } },
          { type: "unknown", label: "Ignored" } as any,
        ]}
      />
    )
    expect(screen.getByText("Label")).toBeInTheDocument()
    expect(screen.getByText("Pro")).toBeInTheDocument()
    expect(screen.getByText("已用 32%")).toBeInTheDocument()
    expect(screen.getByText("已用 $12.34")).toBeInTheDocument()
    expect(screen.getByText("已用 342 credits")).toBeInTheDocument()
  })

  it("applies a text metric color to its value and subtitle", () => {
    render(
      <ProviderCard
        name="Reset Warning"
        displayMode="used"
        lines={[
          {
            type: "text",
            label: "手动重置",
            value: "2 次可用",
            subtitle: "· 下一个 18小时后过期",
            color: "#f59e0b",
          },
        ]}
      />
    )

    expect(screen.getByText("2 次可用")).toHaveStyle({ color: "#f59e0b" })
    expect(screen.getByText("· 下一个 18小时后过期")).toHaveStyle({ color: "#f59e0b" })
  })

  it("allows compact metric labels to leave more room for long values", () => {
    render(
      <ProviderCard
        name="Token Totals"
        displayMode="used"
        lines={[
          { type: "text", label: "今日", value: "$12711.97 · 220.0亿 tokens" },
        ]}
      />
    )

    expect(screen.getByText("今日")).toHaveClass("flex-1")
    expect(screen.getByText("$12711.97 · 220.0亿 tokens")).toHaveClass("truncate", "max-w-[70%]")
  })

  it("renders quick links and opens URL", async () => {
    render(
      <ProviderCard
        name="Links"
        displayMode="used"
        links={[
          { label: "Status", url: "https://status.example.com" },
          { label: "Billing", url: "https://example.com/billing" },
        ]}
      />
    )

    await userEvent.click(screen.getByRole("button", { name: /status/i }))
    expect(openUrl).toHaveBeenCalledWith("https://status.example.com")
    expect(screen.getByRole("button", { name: /billing/i })).toBeInTheDocument()
  })

  it("hides invalid links", () => {
    render(
      <ProviderCard
        name="Links"
        displayMode="used"
        links={[
          { label: " ", url: "https://status.example.com" },
          { label: "Dashboard", url: "ftp://example.com" },
          { label: "Status", url: "https://status.example.com" },
        ]}
      />
    )

    expect(screen.getByRole("button", { name: /status/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /dashboard/i })).toBeNull()
  })

  it("formats fixed-precision numbers with trailing zeros", () => {
    expect(formatFixedPrecisionNumber(Number.NaN)).toBe("0")
    expect(formatFixedPrecisionNumber(5)).toBe("5")
    expect(formatFixedPrecisionNumber(5.129)).toBe("5.13")
    expect(formatFixedPrecisionNumber(5.1)).toBe("5.10")
    expect(formatFixedPrecisionNumber(5.5)).toBe("5.50")
    expect(formatFixedPrecisionNumber(1000)).toBe("1,000")
    expect(formatFixedPrecisionNumber(10000)).toBe("10,000")
    expect(formatFixedPrecisionNumber(1234567.89)).toBe("1,234,567.89")
  })

  it("supports displayMode=left for percent (number + bar fill)", () => {
    render(
      <ProviderCard
        name="Left"
        displayMode="left"
        lines={[
          { type: "progress", label: "Session", used: 42, limit: 100, format: { kind: "percent" } },
        ]}
      />
    )
    expect(screen.getByText("剩余 58%")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "58")
  })

  it("keeps standard reset text at exactly 5 minutes", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:00:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Boundary",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-02T00:05:00.000Z",
          },
        ]}
      />
    )
    expect(screen.getByText("5 分钟后重置")).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("shows tomorrow context for absolute reset labels", () => {
    vi.useFakeTimers()
    const now = new Date(2026, 1, 2, 20, 0, 0)
    const resetsAt = new Date(2026, 1, 3, 9, 30, 0)
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        resetTimerDisplayMode="absolute"
        lines={[
          {
            type: "progress",
            label: "Daily",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: resetsAt.toISOString(),
          },
        ]}
      />
    )
    expect(screen.getByText(/^明日 .* 重置$/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("shows short date context for absolute labels within a week", () => {
    vi.useFakeTimers()
    const now = new Date(2026, 1, 2, 10, 0, 0)
    const resetsAt = new Date(2026, 1, 5, 16, 0, 0)
    vi.setSystemTime(now)
    const dateText = formatMonthDay(resetsAt)
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        resetTimerDisplayMode="absolute"
        lines={[
          {
            type: "progress",
            label: "Weekly",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: resetsAt.toISOString(),
          },
        ]}
      />
    )
    expect(
      screen.getByText((content) => content.startsWith(`${dateText} `) && content.endsWith(" 重置"))
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("shows short date context for absolute labels beyond a week", () => {
    vi.useFakeTimers()
    const now = new Date(2026, 1, 2, 10, 0, 0)
    const resetsAt = new Date(2026, 1, 20, 16, 0, 0)
    vi.setSystemTime(now)
    const dateText = formatMonthDay(resetsAt)
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        resetTimerDisplayMode="absolute"
        lines={[
          {
            type: "progress",
            label: "Monthly",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: resetsAt.toISOString(),
          },
        ]}
      />
    )
    expect(
      screen.getByText((content) => content.startsWith(`${dateText} `) && content.endsWith(" 重置"))
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("omits separator when disabled", () => {
    const { container } = render(
      <ProviderCard
        name="NoSep"
        displayMode="used"
        showSeparator={false}
        lines={[{ type: "text", label: "Label", value: "Value" }]}
      />
    )
    expect(within(container).queryAllByRole("separator")).toHaveLength(0)
  })

  it("filters lines by scope=overview", () => {
    render(
      <ProviderCard
        name="Filtered"
        displayMode="used"
        scopeFilter="overview"
        skeletonLines={[
          { type: "text", label: "Primary", scope: "overview" },
          { type: "text", label: "Secondary", scope: "detail" },
        ]}
        lines={[
          { type: "text", label: "Primary", value: "Shown" },
          { type: "text", label: "Secondary", value: "Hidden" },
        ]}
      />
    )
    expect(screen.getByText("Primary")).toBeInTheDocument()
    expect(screen.getByText("Shown")).toBeInTheDocument()
    expect(screen.queryByText("Secondary")).not.toBeInTheDocument()
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument()
  })

  it("shows all lines when scopeFilter=all", () => {
    render(
      <ProviderCard
        name="All"
        displayMode="used"
        scopeFilter="all"
        skeletonLines={[
          { type: "text", label: "Primary", scope: "overview" },
          { type: "text", label: "Secondary", scope: "detail" },
        ]}
        lines={[
          { type: "text", label: "Primary", value: "One" },
          { type: "text", label: "Secondary", value: "Two" },
        ]}
      />
    )
    expect(screen.getByText("Primary")).toBeInTheDocument()
    expect(screen.getByText("One")).toBeInTheDocument()
    expect(screen.getByText("Secondary")).toBeInTheDocument()
    expect(screen.getByText("Two")).toBeInTheDocument()
  })

})
