import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures/shared-weekly.json"
import { makeCtx } from "../test-helpers.js"

function context(sand, options = {}) {
  const ctx = makeCtx()
  const token = "a." + Buffer.from(JSON.stringify({ sub: "auth0|weekly-user", exp: 9999999999 })).toString("base64") + ".c"
  ctx.host.sqlite.query.mockImplementation((_db, sql) => String(sql).includes("cursorAuth/accessToken") ? JSON.stringify([{ value: token }]) : "[]")
  ctx.host.http.request.mockImplementation(({ url }) => {
    const ok = (value) => ({ status: 200, bodyText: JSON.stringify(value) })
    if (url.endsWith("GetCurrentPeriodUsage")) return ok(options.usage ?? {
      enabled: true,
      planUsage: { limit: 2000, totalSpend: 500, totalPercentUsed: 25, autoPercentUsed: 10, apiPercentUsed: 15 },
      spendLimitUsage: { individualLimit: 1000, individualRemaining: 800 },
      billingCycleStart: "1788220800000", billingCycleEnd: "1790812800000",
    })
    if (url.endsWith("GetPlanInfo")) return ok({ planInfo: { planName: options.plan ?? "Pro" } })
    if (url.endsWith("/api/auth/me")) return ok({ sub: options.identity ?? "auth0|weekly-user" })
    if (url.endsWith("GetSandUsageStatus")) return options.sandFailure ? { status: 503, bodyText: "private error" } : ok(sand)
    if (url.includes("/api/usage?")) return options.legacyFailure ? { status: 403, bodyText: "private error" } : ok(options.legacy ?? {})
    return ok({})
  })
  return ctx
}

async function probe(sand, options) {
  await import("./plugin.js")
  const ctx = context(sand, options)
  return { ctx, output: globalThis.__openusage_plugin.probe(ctx) }
}

describe("Cursor Shared Weekly Quota", () => {
  beforeEach(() => {
    vi.resetModules()
    delete globalThis.__openusage_plugin
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"))
  })
  afterEach(() => vi.useRealTimers())

  it.each(fixtures)("uses explicit protocol fields: $name", async ({ sand, weeklyUsed }) => {
    const { ctx, output } = await probe(sand)
    const weekly = output.lines.find((line) => line.limitResourceKey === "weekly")
    if (weeklyUsed === null) {
      expect(weekly).toBeUndefined()
      expect(output.lines.some((line) => line.label === "Total usage")).toBe(true)
    } else {
      expect(weekly).toMatchObject({ label: "Shared Weekly Usage", used: weeklyUsed, limit: 100, periodDurationMs: 604800000 })
      expect(output.lines.map((line) => line.label)).not.toEqual(expect.arrayContaining(["Total usage"]))
      for (const label of ["Total usage", "Cursor Models", "Other Models", "Grok Bot"]) expect(output.lines.find((line) => line.label === label)).toBeUndefined()
      expect(output.lines.find((line) => line.label === "On-demand")).toMatchObject({ used: 2, limit: 10 })
    }
    expect(ctx.host.http.request.mock.calls.filter(([req]) => req.url.endsWith("GetSandUsageStatus"))).toHaveLength(1)
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("does not infer enterprise request billing from the plan name when shared weekly is proven", async () => {
    const { output } = await probe(fixtures[0].sand, { plan: "Enterprise" })
    expect(output.lines.find((line) => line.limitResourceKey === "weekly")).toBeDefined()
  })

  it("keeps valid legacy Requests ahead of shared weekly", async () => {
    const { output, ctx } = await probe(fixtures[0].sand, {
      plan: "Enterprise", usage: { enabled: true },
      legacy: { "gpt-4": { maxRequestUsage: 500, numRequests: 100 } },
    })
    expect(output.lines.find((line) => line.label === "Requests")).toMatchObject({ used: 100, limit: 500 })
    expect(output.lines.find((line) => line.limitResourceKey === "weekly")).toBeUndefined()
    expect(ctx.host.http.request.mock.calls.filter(([req]) => req.url.endsWith("GetSandUsageStatus"))).toHaveLength(1)
  })

  it("recovers an explicitly missing legacy quota with proven weekly but never hides a legacy transport failure", async () => {
    const options = { plan: "Enterprise", usage: { enabled: true } }
    const { output } = await probe(fixtures[0].sand, options)
    expect(output.lines.find((line) => line.limitResourceKey === "weekly")).toBeDefined()
    await expect(probe(fixtures[0].sand, { ...options, legacyFailure: true })).rejects.toThrow("usage data unavailable")
    await expect(probe(fixtures[0].sand, { ...options, legacy: { error: "" } })).rejects.toThrow("usage data unavailable")
    await expect(probe(fixtures[0].sand, { ...options, legacy: { "gpt-4": null } })).rejects.toThrow("usage data unavailable")
  })

  it("keeps the available monthly plan when optional Sand fails", async () => {
    const { output } = await probe({}, { sandFailure: true })
    expect(output.lines.find((line) => line.label === "Total usage")).toBeDefined()
    expect(output.lines.find((line) => line.label === "On-demand")).toBeDefined()
    expect(output.lines.find((line) => line.limitResourceKey === "weekly")).toBeUndefined()
  })

  it("recovers an enabled individual plan with no monthly quota without accepting an empty base response", async () => {
    const { output } = await probe(fixtures[0].sand, { usage: { enabled: true } })
    expect(output.lines.find((line) => line.limitResourceKey === "weekly")).toBeDefined()
    await expect(probe(fixtures[0].sand, { usage: {} })).rejects.toThrow("No active Cursor subscription")
    await expect(probe(fixtures[0].sand, { usage: { enabled: false } })).rejects.toThrow("No active Cursor subscription")
  })

  it.each([
    { enabled: true, planUsage: [] },
    { enabled: true, planUsage: "invalid" },
    { enabled: true, error: "account unavailable" },
    { enabled: true, planUsage: { limit: -1, totalPercentUsed: 25 } },
    { enabled: true, planUsage: { totalPercentUsed: "25" } },
  ])("does not let an optional shared quota mask a malformed base response %j", async (usage) => {
    await expect(probe(fixtures[0].sand, { usage })).rejects.toThrow("Usage response invalid")
  })

  it("keeps shared weekly quota bound to the exact selected account and rejects another provider identity", async () => {
    await import("./plugin.js")
    const plugin = globalThis.__openusage_plugin
    const ctx = context(fixtures[0].sand)
    const connectionKey = "cursor-desktop"
    const target = { connectionKey, credentialGeneration: plugin.credentialGeneration(ctx, { connectionKey }) }
    expect(plugin.probe(ctx, target).lines.find((line) => line.limitResourceKey === "weekly")).toBeDefined()
    const other = context(fixtures[0].sand, { identity: "other-provider|weekly-user" })
    expect(() => plugin.probe(other, target)).toThrow()
    expect(other.host.http.request.mock.calls.some(([req]) => req.url.endsWith("GetSandUsageStatus"))).toBe(false)
    expect(other.host.sqlite.exec).not.toHaveBeenCalled()
  })
})
