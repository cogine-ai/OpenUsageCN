import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"

const WS = "00000000-0000-4000-8000-000000000001"
const response = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) })
function setup(key = { is_management_key: true }) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((name) => name === "apiKey" ? "synthetic-management-key" : null)
  const routes = { "/key": response({ data: key }), "/credits": response({ data: { total_credits: 100, total_usage: 20 } }),
    "/keys?include_disabled=true&include_expired=true&offset=0": response({ data: [] }), "/activity": response({ data: [] }) }
  ctx.host.http.request.mockImplementation((request) => {
    const path = request.url.replace("https://openrouter.ai/api/v1", "")
    if (!(path in routes)) throw new Error("Unexpected synthetic request")
    return typeof routes[path] === "function" ? routes[path](request) : routes[path]
  })
  return { ctx, routes, plugin: loadTestPlugin("openrouter") }
}
const keyRow = (i, extra = {}) => ({ hash: String(i).padStart(64, "0"), usage_daily: 1, usage_weekly: 2, usage_monthly: 3,
  byok_usage_daily: 4, byok_usage_weekly: 5, byok_usage_monthly: 6, ...extra })
const activity = (extra = {}) => ({ date: "2026-11-03", model: "model/example", requests: 2, usage: 0.5,
  prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30, reasoning_tokens: 10, byok_usage_inference: 0.25, ...extra })
const line = (result, label) => result.lines.find((item) => item.label === label)

describe("OpenRouter management key quota", () => {
  it("aggregates complete pages including disabled and expired keys, with BYOK separate", () => {
    const { ctx, routes, plugin } = setup()
    routes["/keys?include_disabled=true&include_expired=true&offset=0"] = response({ data: Array.from({ length: 100 }, (_, i) => keyRow(i)) })
    routes["/keys?include_disabled=true&include_expired=true&offset=100"] = response({ data: [keyRow(100, { disabled: true, expires_at: "2020-01-01T00:00:00Z" })] })
    const result = plugin.probe(ctx)
    expect(line(result, "Listed Keys Daily Spend").value).toBe("$101.00")
    expect(line(result, "BYOK Daily Spend").value).toBe("$404.00")
    expect(line(result, "Balance").value).toBe("$80.00")
    expect(ctx.host.http.request.mock.calls.some(([request]) => request.url.includes("activity"))).toBe(false)
  })
  it("preserves key spend and shows unavailable balance on workspace credits 403", () => {
    const { ctx, routes, plugin } = setup({ is_management_key: true, workspace_id: WS })
    routes["/credits"] = response({ error: {} }, 403)
    const result = plugin.probe(ctx)
    expect(line(result, "Listed Keys Monthly Spend").value).toBe("$0.00")
    expect(line(result, "Balance")).toBeUndefined()
    expect(line(result, "Balance Status").text).toBe("Balance Unavailable")
    expect(line(result, "Key Scope").value).toBe("Workspace Keys")
  })
  it.each(["failure", "duplicate", "malformed"])("does not publish partial totals after %s page", (mode) => {
    const { ctx, routes, plugin } = setup()
    routes["/keys?include_disabled=true&include_expired=true&offset=0"] = response({ data: Array.from({ length: 100 }, (_, i) => keyRow(i)) })
    routes["/keys?include_disabled=true&include_expired=true&offset=100"] = mode === "failure" ? response({}, 500) :
      response({ data: [mode === "duplicate" ? keyRow(0) : keyRow(101, { usage_weekly: "invalid" })] })
    expect(() => plugin.probe(ctx)).toThrow()
  })
  it("shows malformed balance as unavailable without erasing complete listed-key spend", () => {
    const { ctx, routes, plugin } = setup()
    routes["/credits"] = response({ data: { total_credits: 100, total_usage: -1 } })
    const result = plugin.probe(ctx)
    expect(line(result, "Balance")).toBeUndefined()
    expect(line(result, "Balance Status").text).toBe("Balance Unavailable")
    expect(line(result, "Listed Keys Daily Spend").value).toBe("$0.00")
  })
  it("retains readable credits when key metadata is temporarily unavailable", () => {
    const { ctx, routes, plugin } = setup()
    routes["/key"] = response({}, 503)
    const result = plugin.probe(ctx)
    expect(line(result, "Balance").value).toBe("$80.00")
    expect(line(result, "Key Status").text).toBe("Key Usage Unavailable")
    expect(line(result, "Listed Keys Monthly Spend")).toBeUndefined()
  })
  it("does not invent a BYOK total when one key omitted its counter", () => {
    const { ctx, routes, plugin } = setup()
    routes["/keys?include_disabled=true&include_expired=true&offset=0"] = response({ data: [keyRow(1), keyRow(2, { byok_usage_daily: null })] })
    const result = plugin.probe(ctx)
    expect(line(result, "BYOK Daily Spend")).toBeUndefined()
    expect(line(result, "BYOK Weekly Spend").value).toBe("$10.00")
  })
  it("shares a bounded deadline across pages", () => {
    vi.useFakeTimers()
    try {
      const { ctx, routes, plugin } = setup()
      routes["/keys?include_disabled=true&include_expired=true&offset=0"] = () => {
        vi.advanceTimersByTime(26000)
        return response({ data: Array.from({ length: 100 }, (_, i) => keyRow(i)) })
      }
      expect(() => plugin.probe(ctx)).toThrow(/timed out/)
      expect(ctx.host.http.request.mock.calls).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
})

describe("OpenRouter independent Activity reports", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T12:00:00Z")) })
  afterEach(() => vi.useRealTimers())
  it("reports explicit UTC coverage without zero filling and avoids counting cache/reasoning twice", () => {
    const { ctx, routes, plugin } = setup()
    routes["/activity"] = response({ data: [activity(), activity({ usage: 0.2 })] })
    const result = plugin.probeReports(ctx)
    expect(result.scopeKey).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain("synthetic-management-key")
    expect(line(result, "Activity Scope").value).toBe("Account Activity")
    expect(line(result, "Activity Spend").value).toBe("$0.70")
    expect(line(result, "Activity BYOK Spend").value).toBe("$0.50")
    expect(line(result, "Activity Tokens").value).toBe("240")
    expect(result.reports[0]).toMatchObject({ status: "partial", coverage: {
      fromDate: "2026-10-05", toDate: "2026-11-03", timeZone: "UTC", reportedDates: ["2026-11-03"] } })
    expect(result.reports[0].coverage.missingDates).toHaveLength(29)
    expect(line(result, "Daily Activity Spend").points).toHaveLength(1)
    expect(ctx.host.http.request.mock.calls).toHaveLength(2)
  })
  it("uses only a validated server workspace to scope requests and scope identity", () => {
    const { ctx, routes, plugin } = setup({ is_management_key: true, workspace_id: WS, organization_id: "synthetic-org" })
    routes["/activity?workspace_id=" + WS] = response({ data: [activity()] })
    const first = plugin.probeReports(ctx)
    expect(line(first, "Activity Scope").value).toBe("Workspace Activity")
    expect(JSON.stringify(first)).not.toContain(WS)
    routes["/key"] = response({ data: { is_management_key: true } })
    expect(plugin.probeReports(ctx).scopeKey).not.toBe(first.scopeKey)
  })
  it("does not call Activity for ordinary keys", () => {
    const { ctx, plugin } = setup({ is_management_key: false })
    expect(plugin.probeReports(ctx).reports[0].status).toBe("notSupported")
    expect(ctx.host.http.request.mock.calls).toHaveLength(1)
  })
  it.each([[401, "authExpired"], [403, "permissionDenied"], [429, "rateLimited"], [500, "error"]])("distinguishes Activity HTTP %i", (status, expected) => {
    const { ctx, routes, plugin } = setup()
    routes["/activity"] = response({}, status)
    expect(plugin.probeReports(ctx).reports[0].status).toBe(expected)
    expect(ctx.host.log.error).toHaveBeenCalled()
  })
  it.each([{ date: "2026-11-04" }, { date: "2026-02-30" }, { usage: -1 }, { requests: true }, { prompt_tokens: null }])("rejects malformed activity %j", (extra) => {
    const { ctx, routes, plugin } = setup()
    routes["/activity"] = response({ data: [activity(extra)] })
    const result = plugin.probeReports(ctx)
    expect(result.reports[0].status).toBe("error")
    expect(result.lines).toEqual([])
  })
  it("keeps an empty response visibly incomplete rather than inventing zero days", () => {
    const { ctx, plugin } = setup()
    const result = plugin.probeReports(ctx)
    expect(result.reports[0].coverage.reportedDates).toEqual([])
    expect(result.reports[0].coverage.missingDates).toHaveLength(30)
    expect(line(result, "Activity Spend")).toBeUndefined()
  })
  it("rejects an in-flight credential change without exposing either key", () => {
    const { ctx, routes, plugin } = setup()
    routes["/activity"] = () => {
      ctx.host.config.get.mockImplementation((name) => name === "apiKey" ? "replacement-synthetic-key" : null)
      return response({ data: [activity()] })
    }
    expect(() => plugin.probeReports(ctx)).toThrow(/connection changed/)
  })
})
