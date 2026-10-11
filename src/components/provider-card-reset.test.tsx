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

  it("shows resets secondary text when resetsAt is present", () => {
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
            label: "Monthly",
            used: 12.34,
            limit: 100,
            format: { kind: "dollars" },
            resetsAt: "2026-02-02T01:05:00.000Z",
          },
        ]}
      />
    )
    expect(screen.getByText("1 小时 5 分钟后重置")).toBeInTheDocument()
    expect(
      screen.getByText(
        formatResetTooltipText({
          nowMs: now.getTime(),
          resetsAtIso: "2026-02-02T01:05:00.000Z",
          visibleMode: "relative",
        })!
      )
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("does not render reset tooltip for invalid reset timestamps", () => {
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Invalid",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "not-a-date",
          },
        ]}
      />
    )

    expect(screen.getByText("100% 上限")).toBeInTheDocument()
    expect(screen.queryByText(/^Next reset:/)).not.toBeInTheDocument()
  })

  it("shows '即将重置' when reset is under 5 minutes away", () => {
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
            label: "Short",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-02T00:04:59.000Z",
          },
        ]}
      />
    )
    expect(screen.getByText("即将重置")).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("shows '即将重置' for stale reset timestamps in relative mode", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:06:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Stale Relative",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-02T00:05:00.000Z",
          },
        ]}
      />
    )
    expect(screen.getAllByText("即将重置")).toHaveLength(2)
    vi.useRealTimers()
  })

  it("shows '即将重置' for stale reset timestamps in absolute mode", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:06:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        resetTimerDisplayMode="absolute"
        lines={[
          {
            type: "progress",
            label: "Stale Absolute",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-02T00:05:00.000Z",
          },
        ]}
      />
    )
    expect(screen.getAllByText("即将重置")).toHaveLength(2)
    vi.useRealTimers()
  })

  it("toggles reset timer display mode from its visible icon button", async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 1, 2, 0, 0, 0)
    vi.setSystemTime(now)
    const onToggle = vi.fn()
    const resetsAt = new Date(2026, 1, 2, 1, 5, 0).toISOString()
    render(
      <ProviderCard
        name="Resets"
        displayMode="used"
        resetTimerDisplayMode="absolute"
        onResetTimerDisplayModeToggle={onToggle}
        lines={[
          {
            type: "progress",
            label: "Monthly",
            used: 12.34,
            limit: 100,
            format: { kind: "dollars" },
            resetsAt,
          },
        ]}
      />
    )
    const resetButton = screen.getByRole("button", { name: "切换为重置倒计时" })
    expect(resetButton).toBeInTheDocument()
    expect(
      screen.getByText(
        formatResetTooltipText({
          nowMs: now.getTime(),
          resetsAtIso: resetsAt,
          visibleMode: "absolute",
        })!
      )
    ).toBeInTheDocument()
    fireEvent.click(resetButton)
    expect(onToggle).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

})
