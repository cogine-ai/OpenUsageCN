import { describe, expect, it } from "vitest"

import { type PaceResult } from "@/lib/pace-status"
import {
  buildPaceDetailText,
  formatCompactDuration,
  formatDeficitText,
  formatRunsOutText,
  getPaceStatusText,
} from "@/lib/pace-tooltip"

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const resetsAtMs = Date.parse("2026-02-03T00:00:00.000Z")
const nowMs = Date.parse("2026-02-02T12:00:00.000Z")

describe("pace-tooltip", () => {
  it("maps pace status labels", () => {
    expect(getPaceStatusText("ahead")).toBe("余量充足")
    expect(getPaceStatusText("on-track")).toBe("节奏正常")
    expect(getPaceStatusText("behind")).toBe("可能用完")
  })

  it("formats compact durations", () => {
    expect(formatCompactDuration(30_000)).toBe("< 1 分钟")
    expect(formatCompactDuration(5 * 60_000)).toBe("5 分钟")
    expect(formatCompactDuration((8 * 60 + 5) * 60_000)).toBe("8 小时 5 分钟")
    expect(formatCompactDuration((2 * 24 + 3) * 60 * 60_000)).toBe("2 天 3 小时")
  })

  it("returns null for invalid compact duration", () => {
    expect(formatCompactDuration(Number.NaN)).toBeNull()
    expect(formatCompactDuration(0)).toBeNull()
  })

  it("shows ETA for behind pace", () => {
    // projectedUsage=120, rate=120/ONE_DAY_MS, ETA=(100-60)/rate = 8h
    const paceResult: PaceResult = { status: "behind", projectedUsage: 120 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 60,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "used",
    })
    expect(detail).toBe("8 小时后达上限")
  })

  it("shows projected % used at reset for on-track (displayMode=used)", () => {
    const paceResult: PaceResult = { status: "on-track", projectedUsage: 90 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 45,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "used",
    })
    expect(detail).toBe("重置时已用 90%")
  })

  it("shows projected % left at reset for on-track (displayMode=left)", () => {
    const paceResult: PaceResult = { status: "on-track", projectedUsage: 90 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 45,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "left",
    })
    expect(detail).toBe("重置时剩余 10%")
  })

  it("shows projected % for ahead (displayMode=used)", () => {
    const paceResult: PaceResult = { status: "ahead", projectedUsage: 60 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 30,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "used",
    })
    expect(detail).toBe("重置时已用 60%")
  })

  it("shows projected % for ahead (displayMode=left)", () => {
    const paceResult: PaceResult = { status: "ahead", projectedUsage: 60 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 30,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "left",
    })
    expect(detail).toBe("重置时剩余 40%")
  })

  it("clamps projected percent to 100% when behind without ETA", () => {
    // projectedUsage=120 > limit, but used=0 so rate=0 → no ETA → falls through to clamped %
    const paceResult: PaceResult = { status: "behind", projectedUsage: 120 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 0,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "used",
    })
    expect(detail).toBe("重置时已用 100%")
  })

  it("clamps projected percent in left mode when behind without ETA", () => {
    const paceResult: PaceResult = { status: "behind", projectedUsage: 120 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 0,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "left",
    })
    expect(detail).toBe("重置时剩余 0%")
  })

  it("returns null when pace result is unavailable", () => {
    const detail = buildPaceDetailText({
      paceResult: null,
      used: 30,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "used",
    })
    expect(detail).toBeNull()
  })

  it("falls through to projected % when ETA exceeds remaining time", () => {
    // 90% used at 23:59, only 1 min left — ETA would be ~1.1min but limit won't be hit before reset
    const lateNowMs = Date.parse("2026-02-02T23:59:00.000Z")
    const paceResult: PaceResult = { status: "behind", projectedUsage: 110 }
    const detail = buildPaceDetailText({
      paceResult,
      used: 90,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs: lateNowMs,
      displayMode: "used",
    })
    expect(detail).toBe("重置时已用 100%")
  })
})

describe("formatRunsOutText", () => {
  it("returns ETA text when behind pace", () => {
    const paceResult: PaceResult = { status: "behind", projectedUsage: 120 }
    const result = formatRunsOutText({
      paceResult,
      used: 60,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
    })
    expect(result).toBe("预计 8 小时后用完")
  })

  it("keeps runs-out and limit-in duration text aligned", () => {
    const paceResult: PaceResult = { status: "behind", projectedUsage: 120 }
    const runsOut = formatRunsOutText({
      paceResult,
      used: 60,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
    })
    const detail = buildPaceDetailText({
      paceResult,
      used: 60,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
      displayMode: "used",
    })
    expect(runsOut).toBe("预计 8 小时后用完")
    expect(detail).toBe("8 小时后达上限")
  })

  it("returns null when ahead of pace", () => {
    const paceResult: PaceResult = { status: "ahead", projectedUsage: 60 }
    expect(formatRunsOutText({
      paceResult,
      used: 30,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
    })).toBeNull()
  })

  it("returns null when on-track", () => {
    const paceResult: PaceResult = { status: "on-track", projectedUsage: 90 }
    expect(formatRunsOutText({
      paceResult,
      used: 45,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
    })).toBeNull()
  })

  it("returns null when ETA exceeds remaining time", () => {
    const lateNowMs = Date.parse("2026-02-02T23:59:00.000Z")
    const paceResult: PaceResult = { status: "behind", projectedUsage: 110 }
    expect(formatRunsOutText({
      paceResult,
      used: 90,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs: lateNowMs,
    })).toBeNull()
  })

  it("returns null when pace result is null", () => {
    expect(formatRunsOutText({
      paceResult: null,
      used: 60,
      limit: 100,
      periodDurationMs: ONE_DAY_MS,
      resetsAtMs,
      nowMs,
    })).toBeNull()
  })
})

describe("formatDeficitText", () => {
  it("formats percent deficit in used mode", () => {
    expect(formatDeficitText(4, { kind: "percent" }, "used")).toBe("4% 超节奏")
  })

  it("formats percent deficit in left mode", () => {
    expect(formatDeficitText(4, { kind: "percent" }, "left")).toBe("4% 缺口")
  })

  it("formats dollar deficit", () => {
    expect(formatDeficitText(12.5, { kind: "dollars" }, "used")).toBe("$12.50 超节奏")
  })

  it("formats count deficit", () => {
    expect(formatDeficitText(15, { kind: "count", suffix: "requests" }, "used")).toBe("15 requests 超节奏")
  })

  it("formats decimal count deficit without forced trailing zeros", () => {
    expect(formatDeficitText(4.5, { kind: "count", suffix: "requests" }, "used")).toBe("4.5 requests 超节奏")
  })

  it("rounds percent deficit", () => {
    expect(formatDeficitText(4.7, { kind: "percent" }, "used")).toBe("5% 超节奏")
  })

  it("returns null for tiny percent deficits that round to zero", () => {
    expect(formatDeficitText(0.3, { kind: "percent" }, "used")).toBeNull()
    expect(formatDeficitText(0.3, { kind: "percent" }, "left")).toBeNull()
  })

  it("returns null for tiny dollar deficits that round to zero", () => {
    expect(formatDeficitText(0.004, { kind: "dollars" }, "used")).toBeNull()
  })

  it("returns null for tiny count deficits that round to zero", () => {
    expect(formatDeficitText(0.004, { kind: "count", suffix: "requests" }, "used")).toBeNull()
  })

  it("shows the first displayable percent deficit", () => {
    expect(formatDeficitText(0.5, { kind: "percent" }, "used")).toBe("1% 超节奏")
  })

  it("shows the first displayable dollar deficit", () => {
    expect(formatDeficitText(0.005, { kind: "dollars" }, "used")).toBe("$0.01 超节奏")
  })

  it("shows the first displayable count deficit", () => {
    expect(formatDeficitText(0.005, { kind: "count", suffix: "requests" }, "used")).toBe("0.01 requests 超节奏")
  })
})
