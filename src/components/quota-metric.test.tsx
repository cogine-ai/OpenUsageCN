import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { QuotaMetric } from "@/components/quota-metric"
import type { MetricLine } from "@/lib/plugin-types"

const HOUR = 60 * 60 * 1000
const now = Date.parse("2026-10-11T02:00:00Z")
const line: Extract<MetricLine, { type: "progress" }> = {
  type: "progress", label: "5 小时", used: 62, limit: 100, format: { kind: "percent" },
  resetsAt: new Date(now + 3 * HOUR).toISOString(), periodDurationMs: 5 * HOUR,
}
const defaults = { line, now, displayMode: "left" as const, resetTimerDisplayMode: "relative" as const, timeFormatMode: "24h" as const }

describe("Quota Metric", () => {
  it("restores a single quota bar with its cycle marker and readings below on a 280px content surface", () => {
    const { container, rerender } = render(<div style={{ width: 280 }}><QuotaMetric {...defaults} /></div>)
    expect(screen.getByText("剩余 38%")).toBeVisible()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "38")
    expect(screen.getByText("预计 1 小时 13 分钟后用尽")).toBeVisible()
    expect(screen.getByText("3 小时后重置")).toBeVisible()
    const marker = () => container.querySelector<HTMLElement>('[data-slot="progress-marker"]')
    expect(marker()?.style.left).toBe("60%")
    expect(screen.getByText("22% 缺口")).toBeVisible()
    expect(container.querySelector('[data-slot="pace-indicator"]')).toHaveAttribute("data-state", "behind")
    expect(screen.getAllByRole("progressbar")).toHaveLength(1)
    expect(container.querySelector('[data-slot="pace-timeline"]')).toBeNull()
    expect(container.querySelector('[data-slot="depletion-point"]')).toBeNull()
    expect(container.querySelector('[data-slot="predicted-shortage"]')).toBeNull()
    expect(screen.getByText("5 小时").compareDocumentPosition(screen.getByRole("progressbar")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("progressbar").compareDocumentPosition(screen.getByText("剩余 38%")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    rerender(<div style={{ width: 280 }}><QuotaMetric {...defaults} displayMode="used" /></div>)
    expect(screen.getByText("已用 62%")).toBeVisible()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62")
    expect(marker()?.style.left).toBe("40%")
    expect(screen.getByText("22% 超节奏")).toBeVisible()
    expect(screen.getByText("预计 1 小时 13 分钟后用尽")).toBeVisible()
  })

  it("keeps the full or empty bar free of a marker when exhaustion is known", () => {
    const { container, rerender } = render(<QuotaMetric {...defaults} line={{ ...line, used: 100 }} />)
    expect(screen.getByText("已用尽")).toBeVisible()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
    expect(container.querySelector('[data-slot="pace-indicator"]')).toHaveAttribute("data-state", "exhausted")
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(screen.queryByText(/预计 .*后用尽/)).not.toBeInTheDocument()
    expect(screen.queryByText(/缺口|超节奏/)).not.toBeInTheDocument()
    rerender(<QuotaMetric {...defaults} displayMode="used" line={{ ...line, used: 100, resetsAt: undefined, periodDurationMs: undefined }} />)
    expect(screen.getByText("已用尽")).toBeVisible()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
  })

  it("shows early prediction suppression and missing metadata explicitly", () => {
    const { container, rerender } = render(<QuotaMetric {...defaults} now={now - 1.9 * HOUR} line={{ ...line, used: 1 }} />)
    expect(screen.getByText("刚开始 · 暂无法预测")).toBeVisible()
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(container.querySelector('[data-slot="pace-indicator"]')).toBeNull()
    rerender(<QuotaMetric {...defaults} line={{ ...line, periodDurationMs: undefined }} />)
    expect(screen.getByText("暂无预测")).toBeVisible()
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(container.querySelector('[data-slot="pace-indicator"]')).toBeNull()
  })

  it("retains old quantities, labels their age, and hides predictions on refresh failure", () => {
    const { container } = render(<QuotaMetric {...defaults} stale lastUpdatedAt={now - HOUR} />)
    expect(screen.getByText("剩余 38%")).toBeVisible()
    expect(screen.getByText("上次数据 · 暂无预测")).toBeVisible()
    expect(container.querySelector("time")).toHaveAttribute("datetime", new Date(now - HOUR).toISOString())
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(container.querySelector('[data-slot="pace-indicator"]')).toBeNull()
    expect(screen.queryByText(/缺口|超节奏|预计 .*后用尽/)).not.toBeInTheDocument()
    expect(screen.queryByRole("img", { name: /^现在，/ })).not.toBeInTheDocument()
  })

  it("shows an explicit missing-data state without a zero-percent quota", () => {
    render(<QuotaMetric {...defaults} line={{ ...line, limit: 0 }} />)
    expect(screen.getByText("—")).toBeVisible()
    expect(screen.getByText("额度暂无数据")).toBeVisible()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.queryByText("剩余 0%")).not.toBeInTheDocument()
  })

  it("does not round a positive forecast remainder into a false exhausted state", () => {
    render(<QuotaMetric {...defaults} line={{ ...line, used: 39.96 }} />)
    expect(screen.getByText("重置时预计剩余 <1%")).toBeVisible()
    expect(screen.queryByText("已用尽")).not.toBeInTheDocument()
  })

  it("suppresses live pace while refreshing or waiting for new cycle data", () => {
    const { container, rerender } = render(<QuotaMetric {...defaults} refreshing />)
    expect(screen.getByText("更新中 · 暂无预测")).toBeVisible()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "38")
    expect(container.querySelector('[data-slot="progress-refreshing"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="pace-indicator"]')).toBeNull()
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(screen.queryByText(/缺口|超节奏|预计 .*后用尽/)).not.toBeInTheDocument()
    rerender(<QuotaMetric {...defaults} now={now + 3 * HOUR} />)
    expect(screen.getByText("等待新周期数据")).toBeVisible()
    expect(container.querySelector('[data-slot="pace-indicator"]')).toBeNull()
    expect(container.querySelector('[data-slot="progress-marker"]')).toBeNull()
    expect(screen.queryByText(/缺口|超节奏|预计 .*后用尽/)).not.toBeInTheDocument()
  })

  it("exposes the display switch as a separate visible button, leaving the reset reading static", async () => {
    const onToggle = vi.fn()
    render(<QuotaMetric {...defaults} onResetTimerDisplayModeToggle={onToggle} />)
    expect(screen.getByText("3 小时后重置").closest("button")).toBeNull()
    await userEvent.tab()
    expect(screen.getByRole("button", { name: "切换为具体重置时间" })).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
