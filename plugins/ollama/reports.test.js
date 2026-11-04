import { describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"

const daily = (date = "2026-02-01", overrides = {}) => ({ from: date + "T00:00:00Z", until: date + "T23:00:00Z", request_count: 4, input_tokens: 100, cached_input_tokens: 30, output_tokens: 50, usage_usd: 0.25, groups: [{ model: "fixture-model", request_count: 4, input_tokens: 100, cached_input_tokens: 30, output_tokens: 50, usage_usd: 0.25 }], ...overrides })
function context(body = { granularity: "day", buckets: [daily()] }) {
  const ctx = makeCtx(), config = { source: "apiKey", apiKey: "fixture-key" }
  ctx.host.config.get.mockImplementation((name) => config[name] ?? null)
  ctx.host.http.request.mockImplementation((req) => ({ status: 200, bodyText: JSON.stringify(req.url.endsWith("/api/me") ? { Email: "synthetic@example.invalid", ID: "whole-user-id" } : body) }))
  return { ctx, config }
}
describe("Ollama server reports", () => {
  it("uses distinct 7d/30d server windows with UTC coverage and never fills missing dates with zero", () => {
    const { ctx } = context(), result = loadTestPlugin("ollama").probeReports(ctx)
    expect(result.scopeKey).toMatch(/^[0-9a-f]{64}$/)
    expect(result.scopeKey).not.toContain("whole-user-id")
    expect(result.reports.map((r) => [r.id, r.status])).toEqual([["7d", "partial"], ["30d", "partial"]])
    expect(result.reports[0].coverage).toMatchObject({ fromDate: "2026-01-26", toDate: "2026-02-02", timeZone: "UTC", reportedDates: ["2026-02-01"] })
    expect(result.reports[0].coverage.missingDates).toContain("2026-02-02")
    expect(result.lines.find((l) => l.label === "7D Daily Requests (UTC)").points).toEqual([{ label: "2026-02-01", value: 4 }])
    expect(result.lines.find((l) => l.label === "7D Input Tokens").value).toBe("100")
    expect(result.lines.find((l) => l.label === "7D Cached Input Tokens").value).toBe("30")
    expect(result.lines.find((l) => l.label === "7D Usage Value").value).toBe("$0.2500")
    expect(ctx.host.http.request.mock.calls.map(([req]) => [req.method, req.url])).toEqual([
      ["POST", "https://ollama.com/api/me"], ["GET", "https://ollama.com/api/usage?range=7d&group_by=model"],
      ["GET", "https://ollama.com/api/usage?range=30d&group_by=model"], ["POST", "https://ollama.com/api/me"],
    ])
  })
  it("marks fully reported windows ready and aggregates per-model metrics without double-counting cache", () => {
    const { ctx } = context(), original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((req) => {
      if (!req.url.includes("/api/usage?")) return original(req)
      const count = req.url.includes("range=7d") ? 8 : 31
      const buckets = Array.from({ length: count }, (_, i) => daily(new Date(Date.parse("2026-02-02T00:00:00Z") - i * 86400000).toISOString().slice(0, 10)))
      return { status: 200, bodyText: JSON.stringify({ granularity: "day", buckets }) }
    })
    const result = loadTestPlugin("ollama").probeReports(ctx)
    expect(result.reports.map((r) => r.status)).toEqual(["ready", "ready"])
    expect(result.reports[0].coverage.missingDates).toEqual([])
    expect(result.lines.find((l) => l.label === "7D Model: fixture-model").value).toBe("32 requests · 800 input tokens · 240 cached input tokens (included in input) · 400 output tokens · $2.0000 usage value")
  })
  it("marks an intentionally truncated model list partial while preserving daily totals", () => {
    const groups = Array.from({ length: 101 }, (_, i) => ({ model: "model-" + i, request_count: 1 }))
    const { ctx } = context({ granularity: "day", buckets: [daily("2026-02-01", { request_count: 101, groups })] })
    const result = loadTestPlugin("ollama").probeReports(ctx)
    expect(result.lines.filter((l) => l.label.startsWith("7D Model:")).length).toBe(100)
    expect(result.lines.find((l) => l.label === "7D Requests").value).toBe("101")
    expect(result.reports[0].message).toContain("top 100")
  })
  it("keeps daily totals but does not invent a complete model ranking when remainder is present", () => {
    const { ctx } = context({ granularity: "day", buckets: [daily("2026-02-01", { remainder: { request_count: 1 } })] })
    const result = loadTestPlugin("ollama").probeReports(ctx)
    expect(result.lines.some((l) => l.label.includes("Requests"))).toBe(true)
    expect(result.lines.some((l) => l.label.includes("Model:"))).toBe(false)
    expect(result.reports.every((r) => r.message.includes("model breakdown is incomplete"))).toBe(true)
  })
  it.each([401, 403, 429, 500])("preserves readable 7d output when 30d returns HTTP %s", (status) => {
    const { ctx } = context(), original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((req) => req.url.includes("range=30d") ? { status, bodyText: "SENSITIVE_BODY" } : original(req))
    const result = loadTestPlugin("ollama").probeReports(ctx)
    expect(result.lines.some((l) => l.label === "7D Requests")).toBe(true)
    expect(result.lines.some((l) => l.label.startsWith("30D"))).toBe(false)
    expect(result.reports[1].status).toBe(({ 401: "authExpired", 403: "permissionDenied", 429: "rateLimited", 500: "error" })[status])
    expect(JSON.stringify(result)).not.toContain("SENSITIVE_BODY")
  })
  it("distinguishes no reported usage dates from a reported zero", () => {
    const empty = context({ granularity: "day", buckets: [] }).ctx
    const zero = context({ granularity: "day", buckets: [daily("2026-02-01", { request_count: 0, groups: [] })] }).ctx
    expect(loadTestPlugin("ollama").probeReports(empty).lines).toEqual([])
    expect(loadTestPlugin("ollama").probeReports(zero).lines.find((l) => l.label === "7D Requests").value).toBe("0")
  })
  it.each([
    [daily(), daily()], [daily("2026-01-01")], [daily("2026-02-01", { from: "2026-02-01T01:00:00Z" })],
    [daily("2026-02-01", { request_count: -1 })], [daily("2026-02-01", { cached_input_tokens: 200 })],
    [daily("2026-02-01", { groups: [{ model: "x", request_count: 1 }, { model: "x", request_count: 2 }] })],
  ])("rejects malformed or ambiguous reports as a whole", (...buckets) => {
    // Each case is an array of buckets, passed by Vitest as positional arguments.
    const { ctx } = context({ granularity: "day", buckets })
    const result = loadTestPlugin("ollama").probeReports(ctx)
    expect(result.lines).toEqual([])
    expect(result.reports.every((r) => r.status === "error")).toBe(true)
  })
  it.each(["apiKey", "source", "identity"])("discards data if %s changes while requests run", (changed) => {
    const { ctx, config } = context(), original = ctx.host.http.request.getMockImplementation()
    let identities = 0
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("range=30d") && changed !== "identity") config[changed] = changed === "source" ? "cookie" : "new-key"
      if (req.url.endsWith("/api/me") && ++identities > 1 && changed === "identity") return { status: 200, bodyText: JSON.stringify({ Email: "other@example.invalid", ID: "different-user" }) }
      return original(req)
    })
    expect(() => loadTestPlugin("ollama").probeReports(ctx)).toThrow("account changed")
  })
  it.each([403, "network"])("keeps report identity mandatory even though quota plan details are optional (%s)", (failure) => {
    const { ctx } = context()
    ctx.host.http.request.mockImplementation(() => {
      if (failure === "network") throw Error("PRIVATE_TRANSPORT_ERROR")
      return { status: failure, bodyText: "PRIVATE_IDENTITY_BODY" }
    })
    expect(() => loadTestPlugin("ollama").probeReports(ctx)).toThrow(failure === "network" ? "Could not reach" : "denied access")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.http.request.mock.calls[0][0].url).toBe("https://ollama.com/api/me")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("PRIVATE_")
  })
  it("never issues requests for the existing Cookie source", () => {
    const { ctx, config } = context();config.source = "cookie"
    expect(loadTestPlugin("ollama").probeReports(ctx).reports[0].status).toBe("notSupported")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
  it("bounds all report requests by one total time budget", () => {
    const { ctx } = context(), original = ctx.host.http.request.getMockImplementation(), clock = vi.spyOn(Date, "now")
    let now = 1000;clock.mockImplementation(() => now)
    ctx.host.http.request.mockImplementation((req) => { const result = original(req);if (req.url.includes("range=7d")) now += 26000;return result })
    try {
      expect(() => loadTestPlugin("ollama").probeReports(ctx)).toThrow("time limit")
      expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })
})
