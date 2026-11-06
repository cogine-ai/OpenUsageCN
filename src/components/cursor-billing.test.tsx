import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import fixtures from "./__fixtures__/cursor-history.json"
import type { CompleteHistory } from "@/lib/cursor-history"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { CursorModelUsage } from "./cursor-model-usage"

function show(billing?: CompleteHistory["totals"]["billing"], meteredChargedUsd: number | null = 12) {
  const snapshot = structuredClone(fixtures[0]) as CompleteHistory
  snapshot.totals.meteredChargedUsd = meteredChargedUsd
  if (billing) snapshot.totals.billing = billing
  tauri.invoke.mockImplementation((command) => Promise.resolve(command === "get_cursor_history_snapshot" ? snapshot : { snapshot, stale: false }))
  render(<CursorModelUsage providerId="cursor" accountId="cursor-demo-account" />)
}

describe("Cursor charge classification", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("keeps legacy amounts and Requests while identifying partial charges and all events", async () => {
    show({ usageEventCount: 247, knownOnDemandChargedUsd: 2.5, onDemandCoverage: "incomplete", unclassifiedEventCount: 1 })
    await screen.findByText("Known On-Demand Charges")
    expect(screen.getByText("240 Requests · 760,000 Tokens")).toBeVisible()
    const charges = screen.getByText("Known On-Demand Charges").parentElement!
    expect(within(charges).getByText("$2.50 · Incomplete")).toBeVisible()
    expect(screen.getByText("Usage Events")).not.toBeVisible()
    fireEvent.click(screen.getByText("数据来源"))
    expect(screen.getByText("Usage Events").parentElement).toHaveTextContent("247")
    expect(screen.getByText("Metered Usage").parentElement).toHaveTextContent("$12.00")
    expect(screen.getByText("List-Price Equivalent").parentElement).toHaveTextContent("$20.00")
    expect(screen.getByText(/1 条事件无法确认收费分类/)).toBeVisible()
    expect(screen.getByRole("region", { name: "扣减记录" })).not.toHaveTextContent("$14.50")
    expect(screen.getByRole("region", { name: "扣减记录" })).not.toHaveTextContent("$20.00")
  })

  it("shows unavailable for an old cache instead of a zero charge", async () => {
    show(undefined, null)
    await screen.findByText("On-Demand Charges")
    expect(screen.getByText("On-Demand Charges").parentElement).toHaveTextContent("Unavailable")
    expect(screen.getByText("Metered Usage").parentElement).toHaveTextContent("Unavailable")
    expect(screen.getByText("Usage Events").parentElement).toHaveTextContent("Unavailable")
    expect(screen.getByText(/此缓存尚无收费分类/)).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "扣减记录" })).not.toHaveTextContent("$0.00")
  })

  it("keeps valid zero deductions distinct from unavailable legacy fields", async () => {
    show({ usageEventCount: 0, knownOnDemandChargedUsd: 0, onDemandCoverage: "complete", unclassifiedEventCount: 0 }, 0)
    await screen.findByText("On-Demand Charges")
    expect(screen.getByText("On-Demand Charges").parentElement).toHaveTextContent("$0.00")
    expect(screen.getByText("Metered Usage").parentElement).toHaveTextContent("$0.00")
    expect(screen.getByText("Usage Events").parentElement).toHaveTextContent("0")
    expect(screen.getByRole("region", { name: "扣减记录" })).not.toHaveTextContent("Unavailable")
    expect(screen.queryByText("Incomplete")).not.toBeInTheDocument()
  })
})
