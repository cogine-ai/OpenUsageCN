import "./unified-usage.js"
import fixtures from "./fixtures/unified-usage-status.json"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

function context(options = {}) {
  const ctx = makeCtx()
  ctx.nowIso = fixtures[0].now
  const subject = options.subject ?? "auth0|selected-user"
  const token = "a." + Buffer.from(JSON.stringify({ sub: subject, exp: 9999999999 })).toString("base64") + ".c"
  const otherToken = "a." + Buffer.from(JSON.stringify({ sub: "auth0|unselected-account", exp: 9999999999 })).toString("base64") + ".c"
  const desktopToken = options.unselectedSource && options.connectionKey === "cursor-cli" ? otherToken : token
  ctx.host.sqlite.query.mockImplementation((_db, sql) => String(sql).includes("cursorAuth/accessToken") ? JSON.stringify([{ value: desktopToken }]) : "[]")
  if (options.connectionKey === "cursor-cli" || options.unselectedSource) ctx.host.keychain.readGenericPassword.mockImplementation((service) => service === "cursor-access-token" ? options.connectionKey === "cursor-cli" ? token : otherToken : null)
  ctx.host.http.request.mockImplementation(({ url, headers }) => {
    const ok = (data) => ({ status: 200, bodyText: JSON.stringify(data) })
    if (url.endsWith("GetCurrentPeriodUsage")) return { status: options.usageStatus ?? 200, bodyText: options.usageRaw ?? JSON.stringify(options.usage ?? { enabled: true, planUsage: { limit: 2000, totalSpend: 500, totalPercentUsed: 25 }, spendLimitUsage: { individualLimit: 1000, individualRemaining: 750 } }) }
    if (url.endsWith("GetPlanInfo")) return ok({ planInfo: { planName: options.plan ?? "Pro" } })
    if (url.endsWith("/api/auth/me")) return ok({ sub: options.identity ?? subject })
    if (url.endsWith("GetSandUsageStatus")) return ok(options.sand ?? {})
    if (url.includes("/api/usage?")) return ok(options.legacy ?? {})
    if (url.endsWith("/api/usage-summary") || url.includes("/usage-status?")) {
      expect(headers.Cookie).toBe("WorkosCursorSessionToken=" + subject.split("|").at(-1) + "%3A%3A" + token)
      if (url.endsWith("/api/usage-summary")) return ok(options.summary ?? fixtures[0].summary)
      if (options.status) return { status: options.status, bodyText: "PRIVATE_RESPONSE" }
      return ok(options.payload ?? fixtures[0].payload)
    }
    return ok({})
  })
  return ctx
}
async function probe(options) {
  const ctx = context(options)
  await import("./plugin.js")
  const plugin = globalThis.__openusage_plugin
  const target = options?.connectionKey ? { connectionKey: options.connectionKey } : undefined
  if (target) target.credentialGeneration = options.invalidGeneration ? "0".repeat(64) : plugin.credentialGeneration(ctx, target)
  return { ctx, output: plugin.probe(ctx, target) }
}

describe("Cursor Unified Monthly Additional Spend", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })

  it.each(fixtures)("parses the shared browser and desktop contract: $name", ({ summary, payload, now, expected }) => {
    expect(globalThis.__openusage_cursor_unified.parse(summary, payload, now)).toEqual(expected)
  })

  it("replaces the legacy on-demand value once and keeps included usage", async () => {
    const { output, ctx } = await probe()
    expect(output.lines.filter((line) => line.label === "On-demand")).toEqual([expect.objectContaining({ used: 0.93, limit: 10, limitResourceKey: "onDemand", resetsAt: "2026-11-01T00:00:00Z", periodDurationMs: 2678400000 })])
    expect(output.lines.find((line) => line.label === "Total usage")).toMatchObject({ used: 25 })
    expect(output.lines).toContainEqual({ type: "text", label: "Billing Scope", value: "Current User" })
    expect(ctx.host.http.request.mock.calls.filter(([r]) => r.url.includes("/usage-status?"))).toHaveLength(1)
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
  })

  it("keeps a shared weekly pool independent from monthly spending", async () => {
    const { output } = await probe({ sand: { isUnified: true, includedLimitZero: false, usagePercent: 20, nextResetTimestampUtc: "2099-01-01T00:00:00Z" } })
    expect(output.lines.find((line) => line.limitResourceKey === "weekly")).toBeDefined()
    expect(output.lines.find((line) => line.limitResourceKey === "onDemand").used).toBe(0.93)
  })

  it.each([403, 429, 500])("retains verified legacy spend on optional status HTTP %i", async (status) => {
    const { output, ctx } = await probe({ status })
    expect(output.lines.find((line) => line.label === "On-demand")).toMatchObject({ used: 2.5, limit: 10 })
    expect(ctx.host.log.warn).toHaveBeenCalledWith("Cursor unified monthly additional spending is unavailable")
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("PRIVATE_RESPONSE")
  })

  it.each([{}, { membershipType: "unified_ultra", limitType: "team" }, { membershipType: "pro", limitType: "user" }])("never queries personal billing without explicit scope: %o", async (summary) => {
    const { ctx } = await probe({ summary })
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("/usage-status?"))).toBe(false)
  })

  it("preserves a real zero without adding prepaid credits", async () => {
    const { output } = await probe({ payload: fixtures[1].payload })
    expect(output.lines.find((line) => line.label === "On-demand").used).toBe(0)
  })

  it("uses spend-only text for a reported zero cap", async () => {
    const { output } = await probe({ payload: fixtures[3].payload })
    expect(output.lines.find((line) => line.label === "On-demand")).toMatchObject({ type: "text", value: "USD 0.93" })
  })

  it("keeps explicit request quotas ahead while reading independent personal spending", async () => {
    const { output, ctx } = await probe({ plan: "Enterprise", usage: { enabled: true }, legacy: { "gpt-4": { maxRequestUsage: 500, numRequests: 10 } } })
    expect(output.lines[0]).toMatchObject({ label: "Requests", used: 10, limit: 500 })
    expect(output.lines.find((line) => line.limitResourceKey === "onDemand")).toMatchObject({ used: 0.93, limit: 10 })
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("/usage-status?"))).toBe(true)
  })

  it("uses each selected account's session and never queries history", async () => {
    const a = await probe({ subject: "auth0|account-a" })
    const b = await probe({ subject: "auth0|account-b" })
    expect(a.output.lines.find((line) => line.label === "On-demand").used).toBe(0.93)
    for (const { ctx } of [a, b]) expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("usage-events"))).toBe(false)
  })

  it.each(["cursor-desktop", "cursor-cli"])("returns only verified monthly spending for an enabled no-quota %s binding", async (connectionKey) => {
    const { output, ctx } = await probe({ connectionKey, unselectedSource: true, subject: "auth0|" + connectionKey, usage: { enabled: true }, sand: { isUnified: true, includedLimitZero: true } })
    expect(output.plan).toBe("Pro")
    expect(output.lines.map((line) => line.label)).toEqual(["On-demand", "Billing Scope"])
    expect(output.lines[0]).toMatchObject({ used: 0.93, limit: 10, limitResourceKey: "onDemand" })
    expect(Object.keys(output).sort()).toEqual(["lines", "plan"])
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it.each([
    { status: 403 }, { status: 500 }, { payload: { availability: "identity_unlinked" } },
    { summary: { membershipType: "unified_ultra", limitType: "team" } },
    { summary: { membershipType: "unified_ultra" } },
  ])("keeps the original no-quota error if independent monthly billing cannot be verified: %o", async (options) => {
    await expect(probe({ ...options, connectionKey: "cursor-cli", usage: { enabled: true } })).rejects.toThrow("No active Cursor subscription.")
  })

  it.each([
    [{ usage: { enabled: false } }, "No active Cursor subscription."],
    [{ usage: { enabled: true, planUsage: "invalid" } }, "Usage response invalid"],
    [{ usage: { enabled: true, spendLimitUsage: [] } }, "Usage response invalid"],
    [{ usage: { enabled: true, spendLimitUsage: { individualLimit: "invalid" } } }, "Usage response invalid"],
    [{ usageRaw: "not-json" }, "Usage response invalid"],
    [{ usageStatus: 503 }, "Usage request failed (HTTP 503)"],
    [{ usageStatus: 401 }, "Token expired"],
    [{ identity: "auth0|another-account" }, "identity could not be verified"],
    [{ invalidGeneration: true }, "Account credentials changed"],
  ])("never uses monthly spending to recover a base or identity failure: %o", async (options, error) => {
    const ctx = context({ ...options, connectionKey: "cursor-desktop", usage: options.usage ?? { enabled: true } })
    await import("./plugin.js")
    const plugin = globalThis.__openusage_plugin
    const target = { connectionKey: "cursor-desktop" }
    target.credentialGeneration = options.invalidGeneration ? "0".repeat(64) : plugin.credentialGeneration(ctx, target)
    expect(() => plugin.probe(ctx, target)).toThrow(error)
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.endsWith("/api/usage-summary") || r.url.includes("/usage-status?"))).toBe(false)
  })
})
