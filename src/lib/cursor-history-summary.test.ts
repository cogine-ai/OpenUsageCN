import { describe, expect, it } from "vitest"
import fixtures from "@/components/__fixtures__/cursor-history.json"
import type { CompleteHistory } from "@/lib/cursor-history"
import { historyDateTime, snapshotKey, snapshotTotals } from "@/lib/cursor-history-summary"

const completeSnapshot = fixtures[0] as CompleteHistory

const partialListPriceSnapshot: CompleteHistory = {
  ...completeSnapshot,
  buckets: [
    {
      ...completeSnapshot.buckets[0],
      knownListCostUsd: null,
      listCostCoverage: "partial",
    },
    {
      ...completeSnapshot.buckets[0],
      localDate: "2026-09-02",
      modelName: "gpt-5-mini",
      knownListCostUsd: 4,
      listCostCoverage: "complete",
    },
  ],
}

describe("snapshotTotals", () => {
  it("aggregates token, request, and list-price totals for complete buckets", () => {
    const bucket = completeSnapshot.buckets[0]
    expect(snapshotTotals(completeSnapshot)).toEqual({
      tokens:
        bucket.inputTokens +
        bucket.outputTokens +
        bucket.cacheWriteTokens +
        bucket.cacheReadTokens,
      requests: bucket.requestCount,
      listPrice: bucket.knownListCostUsd,
      knownListPriceBuckets: 1,
      partialListPrice: false,
    })
  })

  it("marks list price as partial when buckets lack complete coverage", () => {
    const totals = snapshotTotals(partialListPriceSnapshot)
    expect(totals.partialListPrice).toBe(true)
    expect(totals.knownListPriceBuckets).toBe(1)
    expect(totals.listPrice).toBe(4)
  })
})

describe("snapshotKey", () => {
  it("uses coverage timestamps as a stable snapshot identity", () => {
    const { fromMs, toMs, fetchedAtMs } = completeSnapshot.coverage
    expect(snapshotKey(completeSnapshot)).toBe(`${fromMs}:${toMs}:${fetchedAtMs}`)
  })
})

describe("historyDateTime", () => {
  it("formats dates in the requested IANA time zone", () => {
    expect(historyDateTime(completeSnapshot.coverage.fromMs, "Asia/Taipei")).toBe("2026-09-01")
    expect(historyDateTime(completeSnapshot.coverage.fromMs, "Asia/Taipei", true)).toMatch(
      /^2026-09-01 \d{2}:\d{2}$/,
    )
  })
})
