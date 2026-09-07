import { describe, expect, it } from "vitest"
import fixtures from "@/components/__fixtures__/cursor-history.json"
import type { CompleteHistory } from "./cursor-history"
import { comparisonUnavailableReason, percentageChange } from "./cursor-history-summary"

describe("recorded history comparison", () => {
  const histories = () => structuredClone(fixtures) as CompleteHistory[]
  it("accepts the same duration and relative position in different billing cycles", () => {
    const [current, previous] = histories()
    expect(comparisonUnavailableReason(current, previous)).toBeNull()
    expect(percentageChange(20, 10)).toBe(100)
  })
  it("rejects shifted, shorter, unknown, incomplete and differently scoped windows", () => {
    const [current, previous] = histories()
    const shifted = structuredClone(previous)
    shifted.coverage.fromMs += 1_000
    shifted.coverage.toMs += 1_000
    const shorter = structuredClone(previous)
    shorter.coverage.toMs -= 1_000
    const legacy = structuredClone(previous)
    delete legacy.coverage.billingCycle
    const incomplete = structuredClone(previous)
    incomplete.coverage.complete = false
    const differentZone = structuredClone(previous)
    differentZone.coverage.timeZone = "UTC"
    const otherAccount = { ...previous, accountId: "another" }
    for (const candidate of [shifted, shorter, legacy, incomplete, differentZone, otherAccount]) {
      expect(comparisonUnavailableReason(current, candidate)).not.toBeNull()
    }
  })
  it("never divides by a zero or invalid baseline", () => {
    for (const baseline of [0, -1, NaN, Infinity]) expect(percentageChange(5, baseline)).toBeNull()
    expect(percentageChange(NaN, 1)).toBeNull()
    expect(percentageChange(0, 10)).toBe(-100)
  })
})
