import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"
const PROD = "https://cloudcode-pa.googleapis.com"
const DAILY = "https://daily-cloudcode-pa.googleapis.com"
const SUMMARY = "/v1internal:retrieveUserQuotaSummary"
const LOAD = "/v1internal:loadCodeAssist"
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) })
const pool = (bucketId, remainingFraction = 0.5, extra = {}) => ({ bucketId, remainingFraction, ...extra })
const body = (...buckets) => ({ groups: [{ displayName: "Gemini Models", buckets }] })
const complete = () => body(pool("gemini-5h", 0.8), pool("gemini-weekly", 0.7), pool("3p-5h", 0.6), pool("3p-weekly", 0.5))
const argon = (buckets) => ({ displayName: "Gemini 4 Argon", buckets })
function setup(production, daily = body()) {
  const ctx = makeCtx()
  ctx.host.fs.writeText(ctx.app.pluginDataDir + "/auth.json", JSON.stringify({ accessToken: "synthetic-token", expiresAtMs: Date.now() + 3600000 }))
  ctx.host.http.request.mockImplementation((request) => {
    if (request.url.endsWith(LOAD)) return reply({ cloudaicompanionProject: "synthetic-project", paidTier: { name: "Google AI Pro" } })
    if (request.url === PROD + SUMMARY) return typeof production === "function" ? production(request) : reply(production)
    if (request.url === DAILY + SUMMARY) return typeof daily === "function" ? daily(request) : reply(daily)
    throw new Error("Unexpected synthetic request")
  })
  return { ctx, plugin: loadTestPlugin("antigravity") }
}
const labels = (result) => result.lines.map((line) => line.label)

describe("Antigravity summary quota identity and cadence", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:00:00Z")) })
  afterEach(() => vi.useRealTimers())
  it("uses four authoritative pools with separate periods and no LS or daily duplicate", () => {
    const { ctx, plugin } = setup({ response: complete() })
    const result = plugin.probe(ctx)
    expect(labels(result)).toEqual(["Gemini", "Gemini Weekly", "Claude", "Claude Weekly"])
    expect(result.lines.map((line) => line.used)).toEqual([20, 30, 40, 50])
    expect(result.lines.map((line) => line.periodDurationMs)).toEqual([18000000, 604800000, 18000000, 604800000])
    expect(result.lines.map((line) => line.limitResourceKey)).toEqual(["geminiSession", "geminiWeekly", "claude", "claudeWeekly"])
    expect(result.plan).toBe("Google AI Pro")
    expect(ctx.host.ls.discover).not.toHaveBeenCalled()
    expect(ctx.host.http.request.mock.calls.map(([r]) => r.url)).toEqual([PROD + LOAD, PROD + SUMMARY])
    expect(JSON.parse(ctx.host.http.request.mock.calls[1][0].bodyText)).toEqual({ project: "synthetic-project" })
  })
  it("production wins overlap while daily fills only missing usable bucket IDs", () => {
    const { ctx, plugin } = setup(body(pool("gemini-5h", 0.8), pool("3p-weekly", undefined, { remainingFraction: null })),
      body(pool("gemini-5h", 0.1), pool("gemini-weekly", 0.6), pool("3p-weekly", 0.3)))
    const result = plugin.probe(ctx)
    expect(labels(result)).toEqual(["Gemini", "Gemini Weekly", "Claude Weekly"])
    expect(result.lines.map((line) => line.used)).toEqual([20, 40, 70])
    expect(ctx.host.http.request.mock.calls.map(([r]) => r.url)).toContain(DAILY + SUMMARY)
  })
  it("preserves explicit zero but never converts absent fractions to depletion", () => {
    const { ctx, plugin } = setup(body(pool("gemini-weekly", 0), { bucketId: "gemini-5h" }, pool("3p-weekly", "bad")))
    const result = plugin.probe(ctx)
    expect(labels(result)).toEqual(["Gemini Weekly"])
    expect(result.lines[0].used).toBe(100)
  })
  it("only the known independent weekly Argon group can produce its own pool", () => {
    const data = complete()
    data.groups.push(argon([pool("argon-independent", 0.25, { window: "weekly", resetTime: "2026-11-10T00:00:00Z" })]))
    const { ctx, plugin } = setup(data)
    const result = plugin.probe(ctx)
    expect(labels(result)).toEqual(["Gemini", "Gemini Weekly", "Argon Weekly", "Claude", "Claude Weekly"])
    const line = result.lines[2]
    expect(line.used).toBe(75)
    expect(line.periodDurationMs).toBe(604800000)
    expect(line.resetsAt).toBe("2026-11-10T00:00:00Z")
  })
  it.each([
    [pool("argon", 1, { window: "weekly", disabled: true })],
    [pool("argon", 1, { window: "weekly", disabled: "false" })],
    [pool("argon", 1, { window: "monthly" })],
    [pool("gemini-weekly", 1, { window: "weekly" })],
    [pool("argon1", 1, { window: "weekly" }), pool("argon2", 0, { window: "weekly" })],
  ])("does not invent disabled, malformed, unknown or shared Argon quota %j", (...buckets) => {
    const data = complete(); data.groups.push(argon(buckets))
    const { ctx, plugin } = setup(data)
    expect(labels(plugin.probe(ctx))).not.toContain("Argon Weekly")
  })
  it("takes Argon from the first usable response without merging hosts into ambiguity", () => {
    const production = body(pool("gemini-5h")); production.groups.push(argon([pool("argon", 0.6, { window: "weekly" })]))
    const daily = complete(); daily.groups.push(argon([pool("argon", 0.1, { window: "weekly" })]))
    const { ctx, plugin } = setup(production, daily)
    expect(plugin.probe(ctx).lines.find((line) => line.label === "Argon Weekly").used).toBe(40)
  })
  it("ignores unknown bucket windows instead of guessing five hours", () => {
    const { ctx, plugin } = setup(body(pool("new-bucket", 0.8, { window: "monthly" }), pool("gemini-weekly", 0.5), pool("gemini-5h", 0.5, { window: "monthly" })))
    expect(labels(plugin.probe(ctx))).toEqual(["Gemini Weekly"])
  })
  it("does not fall back to a different LS account after a subscription refusal", () => {
    const denied = () => reply({ error: { details: [{ reason: "SUBSCRIPTION_REQUIRED" }] } }, 403)
    const { ctx, plugin } = setup(denied, denied)
    ctx.host.ls.discover.mockReturnValue({ ports: [1234] })
    expect(() => plugin.probe(ctx)).toThrow(/no Antigravity quota subscription/)
    expect(ctx.host.ls.discover).not.toHaveBeenCalled()
    expect(ctx.host.log.error).toHaveBeenCalled()
  })
  it("throws subscription failures as controlled strings for the native quota host", () => {
    const refused = () => reply({ error: { details: [{ reason: "SUBSCRIPTION_REQUIRED" }], message: "PRIVATE_RESPONSE" } }, 403)
    const { ctx, plugin } = setup(refused, refused)
    let caught
    try { plugin.probe(ctx) } catch (error) { caught = error }
    expect(caught).toBe("Google reports no Antigravity quota subscription for this project.")
  })
  it("keeps token refusal distinct from subscription failure and does not probe another LS account", () => {
    const refused = () => reply({}, 401)
    const { ctx, plugin } = setup(refused, refused)
    expect(() => plugin.probe(ctx)).toThrow(/sign-in expired/)
    expect(ctx.host.ls.discover).not.toHaveBeenCalled()
  })
  it("does not refresh or replace credentials on server failure", () => {
    const { ctx, plugin } = setup(() => reply({}, 503), () => reply({}, 503))
    expect(() => plugin.probe(ctx)).toThrow(/quota request failed/)
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("oauth2"))).toBe(false)
  })
  it("invalid summary shapes fail visibly rather than being read as empty or legacy", () => {
    const { ctx, plugin } = setup({ unexpected: [] })
    expect(() => plugin.probe(ctx)).toThrow(/response invalid/)
    expect(ctx.host.log.error).toHaveBeenCalled()
  })
  it("shares a total deadline across plan and quota requests", () => {
    const { ctx, plugin } = setup(() => { vi.advanceTimersByTime(26000); return reply(body(pool("gemini-weekly"))) })
    // A partial production response can still be returned; no further network work is allowed.
    const result = plugin.probe(ctx)
    expect(labels(result)).toEqual(["Gemini Weekly"])
    expect(ctx.host.http.request.mock.calls).toHaveLength(2)
    expect(ctx.host.http.request.mock.calls.every(([r]) => r.timeoutMs <= 25000)).toBe(true)
  })
})
