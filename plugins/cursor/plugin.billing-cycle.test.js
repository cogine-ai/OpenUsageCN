import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const START = Date.parse("2026-09-01T00:00:00Z")
const END = Date.parse("2026-10-01T00:00:00Z")

function context(usage, plan = "Pro", legacy = {}) {
  const ctx = makeCtx()
  const token = `a.${Buffer.from(JSON.stringify({ sub: "auth0|fixture", exp: 9999999999 })).toString("base64url")}.c`
  ctx.host.sqlite.query.mockImplementation((_db, sql) => String(sql).includes("cursorAuth/accessToken") ? JSON.stringify([{ value: token }]) : "[]")
  ctx.host.http.request.mockImplementation(({ url }) => ({ status: 200, bodyText: JSON.stringify(
    String(url).includes("GetCurrentPeriodUsage") ? usage
      : String(url).includes("GetPlanInfo") ? { planInfo: { planName: plan } }
        : String(url).includes("cursor.com/api/usage") ? legacy : {}
  ) }))
  return ctx
}

describe("Cursor billing cycle truth", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })

  it.each([undefined, null, "", "invalid", true, [], 0, -1, 1.5, END, END + 1].map((value) => [value]))(
    "keeps usage but no trusted period when the start is %j", async (billingCycleStart) => {
      const ctx = context({ enabled: true, planUsage: { totalSpend: 1200, limit: 2400 }, billingCycleStart, billingCycleEnd: String(END) })
      await import("./plugin.js")
      const line = globalThis.__openusage_plugin.probe(ctx).lines.find((line) => line.label === "Total usage")
      expect(line.used).toBe(50)
      expect(line.resetsAt).toBe("2026-10-01T00:00:00.000Z")
      expect(line).not.toHaveProperty("periodDurationMs")
    }
  )

  it.each([undefined, null, "", "invalid", true, 0, START, START - 1])(
    "does not construct a period from an invalid end %j", async (billingCycleEnd) => {
      const ctx = context({ enabled: true, planUsage: { totalSpend: 1200, limit: 2400 }, billingCycleStart: START, billingCycleEnd })
      await import("./plugin.js")
      const line = globalThis.__openusage_plugin.probe(ctx).lines.find((line) => line.label === "Total usage")
      expect(line.used).toBe(50)
      expect(line).not.toHaveProperty("periodDurationMs")
    }
  )

  it("keeps exact reported dates for a genuine 31-day period", async () => {
    const start = Date.parse("2026-08-01T00:00:00Z")
    const end = START
    const ctx = context({ enabled: true, planUsage: { totalSpend: 1200, limit: 2400 }, billingCycleStart: String(start), billingCycleEnd: String(end) })
    await import("./plugin.js")
    const line = globalThis.__openusage_plugin.probe(ctx).lines.find((line) => line.label === "Total usage")
    expect(line.periodDurationMs).toBe(31 * 86_400_000)
    expect(line.resetsAt).toBe("2026-09-01T00:00:00.000Z")
  })

  it("retains enterprise request counts without guessing a billing end from startOfMonth", async () => {
    const ctx = context({}, "Enterprise", { "gpt-4": { numRequests: 40, maxRequestUsage: 100 }, startOfMonth: "2026-09-01T00:00:00Z" })
    await import("./plugin.js")
    const line = globalThis.__openusage_plugin.probe(ctx).lines.find((line) => line.label === "Requests")
    expect(line.used).toBe(40)
    expect(line.limit).toBe(100)
    expect(line).not.toHaveProperty("periodDurationMs")
    expect(line).not.toHaveProperty("resetsAt")
  })
})
