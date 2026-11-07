import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

import { CursorModelUsage } from "@/components/cursor-model-usage"
import type { CompleteHistory } from "@/lib/cursor-history"

function snapshot() {
  return {
    accountId: "account-1",
    buckets: [
      {
        localDate: "2026-08-24",
        modelName: "composer-1.5",
        inputTokens: 1_000,
        outputTokens: 200,
        cacheWriteTokens: 50,
        cacheReadTokens: 300,
        requestCount: 2,
        knownListCostUsd: 1.25,
        listCostCoverage: "complete" as const,
      },
    ],
    coverage: {
      fromMs: 1_787_400_000_000,
      toMs: 1_787_500_000_000,
      fetchedAtMs: 1_787_500_000_000,
      timeZone: "Asia/Taipei",
      complete: true,
      scope: "sessionVisible" as const,
    },
    totals: {
      meteredChargedUsd: 0.9,
      meteredCoverage: "complete" as const,
    },
  }
}

describe("CursorModelUsage", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.invoke.mockResolvedValue([])
  })

  it("shows loading while the account cache is being read", () => {
    tauri.invoke.mockReturnValue(new Promise(() => {}))

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(screen.getByText("Loading Model Usage…")).toBeInTheDocument()
  })

  it("marks cached data while its detail refresh is still running", async () => {
    const cached = snapshot()
    tauri.invoke
      .mockResolvedValueOnce(cached)
      .mockReturnValueOnce(new Promise(() => {}))

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(await screen.findByText("Refreshing")).toBeInTheDocument()
    expect(screen.queryByText("Cached")).not.toBeInTheDocument()
    expect(screen.getByText("Refreshing")).toBeInTheDocument()
    expect(screen.getByText("composer-1.5")).toBeInTheDocument()
  })

  it("shows complete session-visible model usage and separate cost meanings", async () => {
    const complete = snapshot()
    tauri.invoke
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce({ snapshot: complete, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(await screen.findByRole("heading", { name: "Model Usage" })).toBeInTheDocument()
    expect(screen.getByText("会话记录")).toBeVisible()
    expect(screen.getByText("非账单")).toBeVisible()
    const calls = screen.getByRole("region", { name: "调用" })
    const charges = screen.getByRole("region", { name: "扣减记录" })
    const estimate = screen.getByRole("region", { name: "标价估算" })
    expect(within(calls).getByText("2 Requests · 1,550 Tokens")).toBeVisible()
    expect(within(estimate).getByText("List-Price Equivalent")).toBeVisible()
    expect(within(estimate).getByText("$1.25")).toBeVisible()
    expect(within(charges).getByText("Metered Usage")).toBeVisible()
    expect(within(charges).getByText("$0.90")).toBeVisible()
    expect(within(charges).queryByText("$1.25")).not.toBeInTheDocument()
    expect(within(estimate).queryByText("$0.90")).not.toBeInTheDocument()
    expect(screen.getByText("composer-1.5")).toBeInTheDocument()
    expect(screen.getByText("Input 1,000")).toBeInTheDocument()
    expect(screen.getByText("Output 200")).toBeInTheDocument()
    expect(screen.getByText("Cache Write 50")).toBeInTheDocument()
    expect(screen.getByText("Cache Read 300")).toBeInTheDocument()
    expect(screen.queryByText("Complete Pages")).not.toBeInTheDocument()
    expect(screen.getByText("Coverage 2026-08-22 20:00 – 2026-08-23 23:46")).toBeInTheDocument()
    expect(
      screen.getByText("Updated 2026-08-23 23:46 · Asia/Taipei")
    ).toBeInTheDocument()
  })

  it("expands token details without fetching and resets expansion when the account changes", async () => {
    const complete = snapshot()
    tauri.invoke.mockImplementation((command: string, args: { accountId: string }) => {
      const record = { ...complete, accountId: args.accountId }
      if (command === "get_cursor_history_snapshot") return Promise.resolve(record)
      if (command === "refresh_cursor_history") return Promise.resolve({ snapshot: record, stale: false })
      return Promise.resolve([])
    })
    const { rerender } = render(<CursorModelUsage providerId="cursor" accountId="account-1" />)
    const heading = await screen.findByRole("heading", { name: "composer-1.5" })
    const details = heading.closest("details")!
    expect(details.open).toBe(false)
    const calls = tauri.invoke.mock.calls.length
    fireEvent.click(heading.closest("summary")!)
    await waitFor(() => expect(details.open).toBe(true))
    fireEvent(details, new Event("toggle"))
    expect(screen.getByText("Input 1,000")).toBeVisible()
    expect(tauri.invoke.mock.calls.length).toBe(calls)
    complete.coverage.fetchedAtMs += 1_000
    rerender(<CursorModelUsage providerId="cursor" accountId="account-1" demandRevision={1} />)
    await waitFor(() => expect(tauri.invoke.mock.calls.length).toBeGreaterThan(calls))
    await waitFor(() => expect(screen.queryByText("Refreshing")).not.toBeInTheDocument())
    expect(details.open).toBe(true)
    expect(screen.getByRole("heading", { name: "composer-1.5" }).closest("details")).toHaveAttribute("open")
    rerender(<CursorModelUsage providerId="cursor" accountId="account-2" />)
    expect((await screen.findByRole("heading", { name: "composer-1.5" })).closest("details")).not.toHaveAttribute("open")
  })

  it("combines daily buckets into one total row per model", async () => {
    const complete = snapshot()
    complete.buckets.push({
      ...complete.buckets[0],
      localDate: "2026-08-23",
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 0,
      cacheReadTokens: 100,
      requestCount: 1,
      knownListCostUsd: 0.5,
    })
    tauri.invoke
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce({ snapshot: complete, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(await screen.findAllByRole("heading", { name: "composer-1.5" })).toHaveLength(1)
    expect(screen.getByText("3 Requests · 1,800 Tokens")).toBeInTheDocument()
    expect(screen.getByText("Total Tokens 1,800 · 3 Requests")).toBeInTheDocument()
    expect(screen.getByText("Input 1,100")).toBeInTheDocument()
    expect(screen.getByText("Output 250")).toBeInTheDocument()
    expect(screen.getByText("Cache Read 400")).toBeInTheDocument()
    expect(screen.getByText("List Price $1.75")).toBeInTheDocument()
  })

  it("shows Unknown for an empty raw model name without changing the snapshot", async () => {
    const complete = snapshot()
    complete.buckets[0].modelName = ""
    tauri.invoke
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce({ snapshot: complete, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(await screen.findByRole("heading", { name: "Unknown" })).toBeInTheDocument()
    expect(complete.buckets[0].modelName).toBe("")
  })

  it("labels partial list-price and incomplete metered coverage", async () => {
    const partial = snapshot()
    partial.buckets[0].listCostCoverage = "partial"
    partial.totals.meteredCoverage = "incomplete"
    tauri.invoke
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ snapshot: partial, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    const estimate = await screen.findByRole("region", { name: "标价估算" })
    expect(within(estimate).getByText("Incomplete")).toBeVisible()
    expect(within(screen.getByRole("heading", { name: "composer-1.5" }).closest("summary")!).getByText("Incomplete")).toBeVisible()
    expect(screen.queryByText("Partial Cost")).not.toBeInTheDocument()
    expect(
      screen.getByText("List-Price Equivalent includes only usage with a known model price.")
    ).toBeInTheDocument()
    expect(screen.getByText("$0.90 · Incomplete")).toBeInTheDocument()
  })

  it.each([
    { amount: 0, expected: "$0.00", incomplete: false },
    { amount: null, expected: "Unavailable", incomplete: true },
  ])("keeps a $expected list-price estimate distinct from other amounts", async ({ amount, expected, incomplete }) => {
    const complete: CompleteHistory = snapshot()
    complete.buckets[0].knownListCostUsd = amount
    tauri.invoke
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce({ snapshot: complete, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    const estimate = await screen.findByRole("region", { name: "标价估算" })
    expect(within(estimate).getByText(expected)).toBeVisible()
    expect(Boolean(within(estimate).queryByText("Incomplete"))).toBe(incomplete)
    expect(within(screen.getByRole("region", { name: "扣减记录" })).getByText("$0.90")).toBeVisible()
  })

  it("keeps provenance details available on demand without another fetch", async () => {
    const complete = snapshot()
    tauri.invoke
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce({ snapshot: complete, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)
    await screen.findByRole("region", { name: "调用" })
    await waitFor(() => expect(screen.queryByText("Refreshing")).not.toBeInTheDocument())
    const summary = screen.getByText("数据来源")
    expect(summary.closest("details")).not.toHaveAttribute("open")
    expect(screen.getByText("Usage Events")).not.toBeVisible()
    expect(screen.queryByText("金额来自会话可见记录，不是账单。")).not.toBeInTheDocument()
    const calls = tauri.invoke.mock.calls.length
    fireEvent.click(summary)
    await waitFor(() => expect(screen.getByText("Usage Events")).toBeVisible())
    expect(screen.getByText(/分页完整仅表示/)).toBeVisible()
    expect(screen.getByText(/仅缓存最近一次成功结果/)).toBeVisible()
    expect(tauri.invoke.mock.calls.length).toBe(calls)
  })

  it("keeps cached model usage visible when refresh returns it as stale", async () => {
    const cached = snapshot()
    tauri.invoke
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce({
        snapshot: cached,
        stale: true,
        error: {
          code: "transportUnavailable",
          message: "Cursor model usage could not be refreshed.",
        },
      })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(await screen.findByText("Stale")).toBeInTheDocument()
    expect(screen.getByText("composer-1.5")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Model Usage Stale" })).toBeInTheDocument()
    expect(screen.getByText("Cursor model usage could not be refreshed.")).toBeInTheDocument()
  })

  it("shows an unavailable state when the session has no snapshot", async () => {
    tauri.invoke
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ snapshot: null, stale: false })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(
      await screen.findByRole("heading", { name: "Model Usage Unavailable" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("No Session-Visible Usage is available for this account.")
    ).toBeInTheDocument()
  })

  it("shows the friendly refresh error when no snapshot can be displayed", async () => {
    tauri.invoke
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        snapshot: null,
        stale: false,
        error: {
          code: "authenticationUnavailable",
          message: "Reconnect Cursor and try again.",
        },
      })

    render(<CursorModelUsage providerId="cursor" accountId="account-1" />)

    expect(await screen.findByText("Error")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Model Usage Error" })).toBeInTheDocument()
    expect(screen.getByText("Reconnect Cursor and try again.")).toBeInTheDocument()
  })
})
