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

  it("restores the remaining-cycle marker in left display mode", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T18:00:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Left Pace"
        displayMode="left"
        lines={[
          {
            type: "progress",
            label: "Weekly",
            used: 30,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
        ]}
      />
    )
    const marker = document.querySelector<HTMLElement>('[data-slot="progress-marker"]')
    expect(marker?.style.left).toBe("25%")
    expect(document.querySelector('[data-slot="pace-indicator"]')).toHaveAttribute("data-state", "ahead")
    expect(screen.getByText("重置时预计剩余 60%")).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("shows pace dots and only adds cycle markers for ahead and behind", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T12:00:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Pace"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Ahead",
            used: 30,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
          {
            type: "progress",
            label: "On Track",
            used: 45,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
          {
            type: "progress",
            label: "Behind",
            used: 60,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
        ]}
      />
    )
    expect(screen.getByText("重置时预计剩余 40%")).toBeInTheDocument()
    expect(screen.getByText("重置时预计剩余 10%")).toBeInTheDocument()
    expect(screen.getByText("预计 8 小时后用尽")).toBeInTheDocument()
    const dots = document.querySelectorAll('[data-slot="pace-indicator"]')
    expect(Array.from(dots, (node) => node.getAttribute("data-state"))).toEqual(["ahead", "on-track", "behind"])
    const bars = screen.getAllByRole("progressbar")
    expect(bars[0].querySelector<HTMLElement>('[data-slot="progress-marker"]')?.style.left).toBe("50%")
    expect(bars[1].querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(bars[2].querySelector<HTMLElement>('[data-slot="progress-marker"]')?.style.left).toBe("50%")
    expect(screen.getByText("10% 超节奏")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="pace-timeline"]')).toBeNull()
    vi.useRealTimers()
  })

  it("shows known exhaustion without cycle marker or deficit when already over the limit", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T12:00:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Pace"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Behind",
            used: 120,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
        ]}
      />
    )
    expect(screen.getByText("已用尽")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="pace-indicator"]')).toHaveAttribute("data-state", "exhausted")
    expect(document.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(screen.queryByText(/超节奏/)).not.toBeInTheDocument()
    expect(screen.queryByText(/预计 .*后用尽/)).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it("hides tiny positive deficit text that would round to zero", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T12:00:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Pace"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Behind",
            used: 50.3,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
        ]}
      />
    )
    expect(document.querySelector('[data-slot="pace-indicator"]')).toHaveAttribute("data-state", "behind")
    expect(screen.getByText(/^预计 .*后用尽$/)).toBeInTheDocument()
    expect(screen.queryByText("0% 超节奏")).not.toBeInTheDocument()
    expect(screen.queryByText("0% 缺口")).not.toBeInTheDocument()
    expect(screen.queryByText(/超节奏/)).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it("keeps the zero-usage exception before five percent of the period", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:45:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Pace"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Ahead",
            used: 0,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
        ]}
      />
    )
    expect(screen.getByText("重置时预计剩余 100%")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="pace-indicator"]')).toHaveAttribute("data-state", "ahead")
    expect(document.querySelector('[data-slot="progress-marker"]')).toBeNull()
    vi.useRealTimers()
  })

  it("hides marker when pace is unavailable early in period", () => {
    vi.useFakeTimers()
    const now = new Date("2026-02-02T00:45:00.000Z")
    vi.setSystemTime(now)
    render(
      <ProviderCard
        name="Pace"
        displayMode="used"
        lines={[
          {
            type: "progress",
            label: "Early",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2026-02-03T00:00:00.000Z",
            periodDurationMs: 24 * 60 * 60 * 1000,
          },
        ]}
      />
    )
    expect(screen.getByText("刚开始 · 暂无法预测")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(document.querySelector('[data-slot="pace-indicator"]')).toBeNull()
    vi.useRealTimers()
  })

})
