import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const paid = {
  includedLimitZero: false,
  usagePercent: 25,
  currentPeriodStart: "2026-09-10T03:00:00Z",
  nextResetTimestampUtc: "2026-09-17T03:00:00Z",
}
const jwt = (sub) => `a.${Buffer.from(JSON.stringify({ sub, exp: 9999999999 })).toString("base64")}.c`

async function setup(sand = paid) {
  await import("./plugin.js")
  const plugin = globalThis.__openusage_plugin
  const ctx = makeCtx()
  const desktop = jwt("auth0|desktop")
  const cli = jwt("auth0|cli")
  ctx.host.sqlite.query.mockImplementation((_db, sql) => String(sql).includes("cursorAuth/accessToken")
    ? JSON.stringify([{ value: desktop }]) : "[]")
  ctx.host.keychain.readGenericPassword.mockImplementation((service) => service === "cursor-access-token" ? cli : null)
  ctx.host.http.request.mockImplementation((request) => {
    if (request.url.endsWith("GetCurrentPeriodUsage")) return { status: 200, bodyText: JSON.stringify({
      enabled: true, planUsage: { limit: 100, remaining: 75, totalPercentUsed: 25, autoPercentUsed: 30, apiPercentUsed: 20 },
    }) }
    if (request.url.endsWith("GetSandUsageStatus")) {
      if (sand instanceof Error) throw sand
      if (sand && "status" in sand) return sand
      return { status: 200, bodyText: JSON.stringify(sand) }
    }
    if (request.url.endsWith("/api/auth/me")) return { status: 200, bodyText: JSON.stringify({ sub: "auth0|cli" }) }
    return { status: 200, bodyText: "{}" }
  })
  return { plugin, ctx, desktop, cli }
}

const grok = (result) => result.lines.find((line) => line.label === "Grok Bot")

describe("Cursor Grok Bot quota", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it.each([0, 25, 100, 125])("renders %s percent without treating zero or exhaustion as absent", async (used) => {
    const { plugin, ctx, desktop } = await setup({ ...paid, usagePercent: used, hasAvailableUsage: used < 100 })
    expect(grok(plugin.probe(ctx))).toMatchObject({ type: "progress", used: Math.min(100, used), limit: 100,
      resetsAt: "2026-09-17T03:00:00.000Z", periodDurationMs: 7 * 86400000 })
    expect(ctx.host.http.request).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus", method: "POST", bodyText: "{}", timeoutMs: 5000,
      headers: expect.objectContaining({ Authorization: `Bearer ${desktop}` }),
    }))
  })

  it.each([
    ["enterprise", {}, 200],
    ["team", { planUsage: {} }, 200],
    ["", {}, 503],
    ["pro", { planUsage: {} }, 200],
    ["pro", { planUsage: { totalPercentUsed: 25 }, spendLimitUsage: { limitType: "team" } }, 200],
  ])("includes Grok Bot once after a successful %s request-based fallback", async (plan, usage, planStatus) => {
    const { plugin, ctx, desktop } = await setup()
    const normalRequest = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => {
      if (request.url.endsWith("GetCurrentPeriodUsage")) return { status: 200, bodyText: JSON.stringify({ enabled: true, ...usage }) }
      if (request.url.endsWith("GetPlanInfo")) return { status: planStatus, bodyText: JSON.stringify({ planInfo: { planName: plan } }) }
      if (request.url.startsWith("https://cursor.com/api/usage?")) return { status: 200, bodyText: JSON.stringify({ "gpt-4": { numRequests: 12, maxRequestUsage: 500 } }) }
      return normalRequest(request)
    })
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Requests")).toMatchObject({ used: 12, limit: 500 })
    expect(result.lines.some((line) => line.label === "Total usage")).toBe(false)
    expect(result.lines.filter((line) => line.label === "Grok Bot")).toHaveLength(1)
    const sandCalls = ctx.host.http.request.mock.calls.map(([request]) => request).filter((request) => request.url.endsWith("GetSandUsageStatus"))
    expect(sandCalls).toHaveLength(1)
    expect(sandCalls[0].headers.Authorization).toBe(`Bearer ${desktop}`)
    expect(sandCalls[0].timeoutMs).toBe(5000)
  })

  it("uses only the explicitly selected CLI token for the optional request", async () => {
    const { plugin, ctx, cli } = await setup()
    const connectionKey = "cursor-cli"
    plugin.probe(ctx, { connectionKey, credentialGeneration: plugin.credentialGeneration(ctx, { connectionKey }) })
    const request = ctx.host.http.request.mock.calls.map(([value]) => value).find((value) => value.url.endsWith("GetSandUsageStatus"))
    expect(request.headers.Authorization).toBe(`Bearer ${cli}`)
  })

  it.each([NaN, Infinity, -1, "25", null])("keeps monthly quota and marks malformed percentage %s unavailable", async (used) => {
    const { plugin, ctx } = await setup({ ...paid, usagePercent: used })
    const result = plugin.probe(ctx)
    expect(grok(result)).toMatchObject({ type: "text", value: "Unavailable" })
    expect(result.lines.find((line) => line.label === "Total usage").used).toBe(25)
    expect(ctx.host.log.warn).toHaveBeenCalledWith("Grok Bot usage unavailable; keeping the current Cursor plan usage")
  })

  it.each([{ status: 503, bodyText: "secret-response" }, new Error("secret-token")])("does not leak errors or discard monthly quota", async (error) => {
    const { plugin, ctx } = await setup(error)
    expect(grok(plugin.probe(ctx))).toMatchObject({ type: "text", value: "Unavailable" })
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("secret-")
  })

  it("does not render a personal meter for a pooled enterprise allowance", async () => {
    const { plugin, ctx } = await setup({ ...paid, usesPooledEnterpriseAllowance: true })
    expect(grok(plugin.probe(ctx))).toBeUndefined()
  })

  it.each(["2000-01-01T00:00:00Z", "not-a-date", "2099"])("hides zero included allowance with expired or invalid trial %s", async (expiry) => {
    const { plugin, ctx } = await setup({ ...paid, includedLimitZero: true, sandTrialExpiresAt: expiry })
    expect(grok(plugin.probe(ctx))).toBeUndefined()
  })

  it("ignores malformed paid timestamps without inventing a weekly period", async () => {
    const { plugin, ctx } = await setup({ ...paid, currentPeriodStart: "2026", nextResetTimestampUtc: "tomorrow" })
    const line = grok(plugin.probe(ctx))
    expect(line.used).toBe(25)
    expect(line.resetsAt).toBeUndefined()
    expect(line.periodDurationMs).toBeUndefined()
  })

  it("hides an explicitly zero allowance while preserving monthly quota", async () => {
    const { plugin, ctx } = await setup({ ...paid, includedLimitZero: true, hasNonZeroIncludedLimit: true })
    const result = plugin.probe(ctx)
    expect(grok(result)).toBeUndefined()
    expect(result.lines.some((line) => line.label === "Total usage")).toBe(true)
  })

  it("shows exhausted unexpired trials without inventing recurring reset dates", async () => {
    const { plugin, ctx } = await setup({ ...paid, includedLimitZero: true, usagePercent: 100, sandTrialExpiresAt: "2099-01-01T00:00:00Z" })
    const line = grok(plugin.probe(ctx))
    expect(line).toMatchObject({ used: 100 })
    expect(line.resetsAt).toBeUndefined()
    expect(line.periodDurationMs).toBeUndefined()
  })

  it("does not use trial expiry to replace paid allowance reset", async () => {
    const { plugin, ctx } = await setup({ ...paid, sandTrialExpiresAt: "2099-01-01T00:00:00Z" })
    expect(grok(plugin.probe(ctx)).resetsAt).toBe("2026-09-17T03:00:00.000Z")
  })

  it("keeps allowance visible without fabricating missing period dates", async () => {
    const { plugin, ctx } = await setup({ hasNonZeroIncludedLimit: true, usagePercent: 0 })
    const line = grok(plugin.probe(ctx))
    expect(line).toMatchObject({ used: 0 })
    expect(line.resetsAt).toBeUndefined()
    expect(line.periodDurationMs).toBeUndefined()
  })
})
