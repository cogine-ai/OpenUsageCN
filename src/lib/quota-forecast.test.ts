import { describe, expect, it } from "vitest"
import { quotaForecast } from "@/lib/quota-forecast"

const HOUR = 60 * 60 * 1000
const observation = { used: 62, limit: 100, resetsAtMs: 5 * HOUR, periodDurationMs: 5 * HOUR, now: 2 * HOUR }

describe("Quota Forecast", () => {
  it("places depletion within the remaining time, rather than at the elapsed-period percentage", () => {
    const result = quotaForecast(observation)
    expect(result.state).toBe("behind")
    expect(result.depletionInMs! / 60_000).toBeCloseTo(73.5484, 4)
    expect(result.depletionFraction).toBeCloseTo(0.408602, 6)
  })

  it.each([
    [40, "ahead", 20],
    [40.01, "on-track", 19.98],
    [50, "on-track", 0],
    [50.01, "behind", undefined],
  ] as const)("keeps the existing 80/100 percent thresholds for used=%s", (used, state, remaining) => {
    const result = quotaForecast({ ...observation, used, now: 2.5 * HOUR })
    expect(result.state).toBe(state)
    if (remaining !== undefined) expect(result.remainingAtReset).toBeCloseTo(remaining)
    else expect(result.depletionFraction).toBeLessThan(1)
  })

  it("does not predict during the first five percent, but retains zero-usage and depleted exceptions", () => {
    const early = { ...observation, now: 0.1 * HOUR }
    expect(quotaForecast({ ...early, used: 1 })).toEqual({ state: "early" })
    expect(quotaForecast({ ...early, used: 0 })).toEqual({ state: "ahead", remainingAtReset: 100 })
    expect(quotaForecast({ ...early, used: 100 })).toEqual({ state: "exhausted", depletionFraction: 0 })
  })

  it("never invents an exhaustion time when reset or period metadata is absent", () => {
    expect(quotaForecast({ ...observation, resetsAtMs: Number.NaN })).toEqual({ state: "unavailable" })
    expect(quotaForecast({ ...observation, periodDurationMs: undefined })).toEqual({ state: "unavailable" })
    expect(quotaForecast({ ...observation, periodDurationMs: 0 })).toEqual({ state: "unavailable" })
  })

  it("keeps known exhaustion distinct from unavailable predictions", () => {
    expect(quotaForecast({ ...observation, used: 120, resetsAtMs: Number.NaN, periodDurationMs: undefined }))
      .toEqual({ state: "exhausted", depletionFraction: 0 })
  })

  it("does not present old quota readings as a real-time prediction or present exhaustion", () => {
    expect(quotaForecast({ ...observation, stale: true })).toEqual({ state: "stale" })
    expect(quotaForecast({ ...observation, used: 100, refreshing: true })).toEqual({ state: "refreshing" })
    expect(quotaForecast({ ...observation, used: 100, now: 5 * HOUR })).toEqual({ state: "resetting" })
  })

  it("does not interpret missing or invalid quota data as zero remaining", () => {
    expect(quotaForecast({ ...observation, limit: 0 })).toEqual({ state: "unavailable" })
    expect(quotaForecast({ ...observation, used: Number.NaN })).toEqual({ state: "unavailable" })
  })
})
