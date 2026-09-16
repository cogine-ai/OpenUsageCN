import manifest from "../../plugins/cursor/plugin.json"
import { render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OverviewPage } from "./overview"
import { ProviderDetailPage } from "./provider-detail"
import type { ManifestLine, MetricLine, PluginDisplayState } from "@/lib/plugin-types"

const monthlyReset = "2026-10-01T00:00:00Z"
const weeklyReset = "2026-09-19T00:00:00Z"
function progress(label: string, used: number, resetsAt = monthlyReset): MetricLine {
  return { type: "progress", label, used, limit: 100, format: { kind: "percent" }, resetsAt }
}
function plugin(lines: MetricLine[]): PluginDisplayState {
  return {
    meta: { id: manifest.id, name: manifest.name, iconUrl: "", lines: manifest.lines as ManifestLine[] },
    data: { providerId: "cursor", displayName: "Cursor", iconUrl: "", lines },
    loading: false, error: null, lastUpdatedAt: null, lastManualRefreshAt: null,
  }
}
const pools = [progress("Total usage", 49), progress("Cursor Models", 21), progress("Other Models", 64), progress("Grok Bot", 87, weeklyReset)]
function row(label: string) {
  return within(screen.getByText(label).parentElement!)
}

describe("Cursor Pool Presentation", () => {
  afterEach(() => vi.useRealTimers())

  it.each(["used", "left"] as const)("shows three independent pools in %s mode with their own resets", (displayMode) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"))
    render(<OverviewPage plugins={[plugin(pools)]} displayMode={displayMode} resetTimerDisplayMode="relative" />)
    expect(screen.queryByText("Total usage")).not.toBeInTheDocument()
    expect(row("Cursor Models").getByText(displayMode === "used" ? "21%" : "剩余 79%")).toBeInTheDocument()
    expect(row("Other Models").getByText(displayMode === "used" ? "64%" : "剩余 36%")).toBeInTheDocument()
    expect(row("Grok Bot").getByText(displayMode === "used" ? "87%" : "剩余 13%")).toBeInTheDocument()
    expect(row("Cursor Models").getByText(/15 天后重置/)).toBeInTheDocument()
    expect(row("Other Models").getByText(/15 天后重置/)).toBeInTheDocument()
    expect(row("Grok Bot").getByText(/3 天后重置/)).toBeInTheDocument()
  })

  it("retains monthly Total alongside the pools in detail without changing input labels", () => {
    render(<ProviderDetailPage plugin={plugin(pools)} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(row("Monthly Total").getByText("49%")).toBeInTheDocument()
    for (const label of ["Cursor Models", "Other Models", "Grok Bot"]) expect(screen.getByText(label)).toBeInTheDocument()
    expect(pools[0].label).toBe("Total usage")
    expect(manifest.lines.find((line) => line.label === "Total usage")?.primaryOrder).toBe(2)
  })

  it.each(["Total usage", "Credits", "Requests"])("retains legacy or team %s when monthly pools are absent", (label) => {
    render(<OverviewPage plugins={[plugin([progress(label, 42)])]} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(row(label).getByText("42%")).toBeInTheDocument()
  })

  it("does not let an independent Grok Bot pool hide a team Total", () => {
    render(<OverviewPage plugins={[plugin([progress("Total usage", 42), progress("Grok Bot", 11, weeklyReset)])]} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("Total usage")).toBeInTheDocument()
    expect(screen.getByText("Grok Bot")).toBeInTheDocument()
  })

  it("retains Total when only one monthly pool is available", () => {
    render(<OverviewPage plugins={[plugin([progress("Total usage", 42), progress("Cursor Models", 11)])]} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("Total usage")).toBeInTheDocument()
    expect(screen.getByText("Cursor Models")).toBeInTheDocument()
  })

  it("retains a team's dollar budget even when both percentage pools are available", () => {
    const total: MetricLine = { type: "progress", label: "Total usage", used: 25, limit: 100, format: { kind: "dollars" } }
    render(<OverviewPage plugins={[plugin([total, ...pools.slice(1)])]} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(row("Total usage").getByText("$25")).toBeInTheDocument()
    expect(row("Total usage").getByText("$100 上限")).toBeInTheDocument()
    for (const label of ["Cursor Models", "Other Models", "Grok Bot"]) expect(screen.getByText(label)).toBeInTheDocument()
  })

  it("keeps resource identity stable and gives Grok Bot a separate resource without assuming a fixed period", () => {
    expect(manifest.lines.find((line) => line.label === "Cursor Models")?.limitResource.key).toBe("autoUsage")
    expect(manifest.lines.find((line) => line.label === "Other Models")?.limitResource.key).toBe("apiUsage")
    expect(manifest.lines.find((line) => line.label === "Grok Bot")).not.toHaveProperty("period")
    expect(manifest.lines.find((line) => line.label === "Grok Bot")).toMatchObject({
      scope: "overview", limitResource: { key: "grokBotUsage" },
    })
  })

  it("shows an unavailable Grok Bot status alongside successful monthly pools", () => {
    render(<OverviewPage plugins={[plugin([...pools.slice(0, 3), { type: "text", label: "Grok Bot", value: "Unavailable" }])]} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("Cursor Models")).toBeInTheDocument()
    expect(screen.getByText("Other Models")).toBeInTheDocument()
    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(screen.queryByText("Total usage")).not.toBeInTheDocument()
  })
})
