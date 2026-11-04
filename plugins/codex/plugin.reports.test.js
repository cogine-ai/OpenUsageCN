import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"

const AUTH_PATH = "~/.config/codex/auth.json"
function auth(subject = "full-user", workspace = "workspace-a", extra = {}) {
  const token = "header." + Buffer.from(JSON.stringify({ sub: subject, exp: 9999999999 })).toString("base64url") + ".signature"
  return JSON.stringify({ tokens: { access_token: token, account_id: workspace }, ...extra })
}
function setup(plan = "pro") {
  const ctx = makeCtx()
  ctx.host.fs.writeText(AUTH_PATH, auth())
  ctx.host.fs.writeText.mockClear()
  const response = { counts: { data: [{ date: "2026-11-04", totals: { turns: 2, text_total_tokens: 12, credits: 9000 } }] },
    credits: { data: [{ date: "2026-11-04", premium_usage_values: { credit_usage_credits: { cli: -2.5 } } }] } }
  ctx.host.http.request.mockImplementation((opts) => {
    const body = opts.url.includes("daily-workspace-usage-counts") ? response.counts
      : opts.url.includes("daily-workspace-user") ? response.credits : { plan_type: plan }
    return { status: 200, headers: {}, bodyText: JSON.stringify(body) }
  })
  const plugin = loadTestPlugin("codex")
  return { ctx, response, plugin }
}
describe("Codex server reports", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:05:00Z")) })
  afterEach(() => { vi.useRealTimers() })

  it("loads UTC reports separately, keeps unreported days distinct and excludes relative credits", () => {
    const { ctx, plugin } = setup()
    const result = plugin.probeReports(ctx)
    expect(result.scopeKey).toMatch(/^[a-f0-9]{64}$/)
    expect(result.reports[0].coverage).toMatchObject({ fromDate: "2026-10-06", toDate: "2026-11-04", timeZone: "UTC", reportedDates: ["2026-11-04"] })
    expect(result.reports[0].coverage.missingDates).toHaveLength(29)
    expect(result.lines.find((line) => line.label === "Daily Tokens").points).toEqual([{ label: "2026-11-04", value: 12, valueLabel: "12 tokens" }])
    expect(result.lines.some((line) => /credits/i.test(line.value || ""))).toBe(false)
    expect(ctx.host.http.request.mock.calls[0][0]).toMatchObject({ method: "GET", headers: { "ChatGPT-Account-Id": "workspace-a" } })
    expect(ctx.host.http.request.mock.calls[0][0].url).toContain("group_by=day&workspace_user=true")
    expect(ctx.host.ccusage.query).not.toHaveBeenCalled()
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("keeps signed charged credits as text and adds duplicate UTC records", () => {
    const { ctx, plugin, response } = setup("team")
    response.counts.data.push({ date: "2026-11-04", totals: { turns: 1, text_total_tokens: 5 } })
    const result = plugin.probeReports(ctx)
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Tokens", value: "17 tokens" }))
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Credits", value: "-2.5 credits" }))
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "2026-11-04 Charged Credits", value: "-2.5 credits" }))
    expect(result.lines.filter((line) => line.type === "barChart").every((line) => !line.label.includes("Credits"))).toBe(true)
  })

  it.each(["business", "enterprise", "edu"])("selects enterprise charged credits for %s", (plan) => {
    const { ctx, plugin, response } = setup(plan)
    response.credits = { data: [{ date: "2026-11-04", values: { model1: 3, model2: -1 } }] }
    const result = plugin.probeReports(ctx)
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Credits", value: "2 credits" }))
    expect(ctx.host.http.request.mock.calls[2][0].url).toContain("daily-workspace-user-credit-usage?")
    expect(ctx.host.http.request.mock.calls[2][0].url).toContain("breakdown=model")
  })

  it.each([403, 429, 500, 401])("keeps counts when credits returns %s", (status) => {
    const { ctx, plugin } = setup("team")
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((opts) => opts.url.includes("token-usage-breakdown")
      ? { status, headers: { "retry-after": "60" }, bodyText: "{}" } : original(opts))
    const result = plugin.probeReports(ctx)
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Tokens", value: "12 tokens" }))
    expect(result.reports[1].status).toBe(({ 403: "permissionDenied", 429: "rateLimited", 500: "error", 401: "authExpired" })[status])
    if (status === 429) expect(result.reports[1].retryAt).toBe("2026-11-04T00:06:00.000Z")
  })

  it.each([
    { data: [{ date: "2026-11-04", totals: { turns: -1 } }] },
    { data: [{ date: "2026-11-04", totals: { turns: 1, text_total_tokens: "broken" } }] },
    { data: [{ date: "2026-02-30", totals: { turns: 1 } }] },
    { data: [], has_more: true },
    { data: [{ date: "2026-11-04Tbroken", totals: { turns: 1 } }] },
  ])("rejects malformed or incomplete counts report without publishing partial rows", (counts) => {
    const { ctx, plugin, response } = setup(); response.counts = counts
    const result = plugin.probeReports(ctx)
    expect(result.reports[0].status).toBe("error"); expect(result.lines).toEqual([])
  })

  it("does not reinterpret relative credits as charged credits or drop other valid days", () => {
    const { ctx, plugin, response } = setup("team")
    response.credits.data.push({ date: "2026-11-03", models: [{ credits: 100 }] })
    const result = plugin.probeReports(ctx)
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Credits", value: "-2.5 credits" }))
    expect(result.reports[1].coverage.reportedDates).toEqual(["2026-11-04"])
  })

  it.each([
    auth("other-user"), auth("full-user", "workspace-b"), auth("full-user", "workspace-a", { extra: "rotated" }),
    auth("provider|full-user"), "malformed",
  ])("rejects late reports after any raw credential or complete identity change", (replacement) => {
    const { ctx, plugin } = setup("team")
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((opts) => { const response = original(opts); ctx.host.fs.writeText(AUTH_PATH, replacement); return response })
    expect(() => plugin.probeReports(ctx)).toThrow(/credentials changed|complete account identity/)
  })

  it("rejects absent full subject/workspace and never falls back after the fixed source rejects", () => {
    const { ctx, plugin } = setup()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ tokens: { access_token: "opaque" } }))
    ctx.host.keychain.readGenericPassword.mockReturnValue(auth())
    expect(() => plugin.probeReports(ctx)).toThrow("complete account identity")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
  })

  it("recognizes expired tokens without refreshing or writing credentials", () => {
    const { ctx, plugin } = setup()
    const token = "header." + Buffer.from(JSON.stringify({ sub: "user", exp: 1 })).toString("base64url") + ".signature"
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ tokens: { access_token: token, account_id: "workspace" } }))
    ctx.host.fs.writeText.mockClear()
    expect(plugin.probeReports(ctx).reports[0].status).toBe("authExpired")
    expect(ctx.host.http.request).not.toHaveBeenCalled(); expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
  })
  it("reports API-key-only authentication as unsupported without making requests", () => {
    const { ctx, plugin } = setup()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ OPENAI_API_KEY: "synthetic-api-key" }))
    expect(plugin.probeReports(ctx).reports[0].status).toBe("notSupported")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("checks the exact original keychain payload and rejects even whitespace-only credential changes", () => {
    const { ctx, plugin } = setup("team")
    ctx.host.fs.exists = () => false
    let raw = auth()
    ctx.host.keychain.readGenericPassword.mockImplementation(() => raw)
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((opts) => { const result = original(opts); raw += " "; return result })
    expect(() => plugin.probeReports(ctx)).toThrow("credentials changed")
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("preserves incomplete model attribution independently of the total counts", () => {
    const { ctx, response, plugin } = setup("team")
    response.counts.data[0].models = [{ model: "model-a", turns: 1 }]
    response.credits.data[0].models = [{ model: "model-a", on_demand_credits: -1 }, { model: "model-b", credits: 400 }]
    const result = plugin.probeReports(ctx)
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Turns", value: "2 turns" }))
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Model Turns: model-a", value: "1 turns" }))
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Model Credits: model-a", value: "-1 credits" }))
    expect(result.lines.some((line) => line.label.includes("model-b"))).toBe(false)
  })

  it("rejects a new higher-priority local login appearing during a keychain report", () => {
    const { ctx, plugin } = setup("team")
    let fileAppeared = false
    ctx.host.fs.exists = (path) => path === AUTH_PATH && fileAppeared
    ctx.host.keychain.readGenericPassword.mockReturnValue(auth())
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((opts) => { const result = original(opts); fileAppeared = true; return result })
    expect(() => plugin.probeReports(ctx)).toThrow("credentials changed")
  })

  it.each(["permission", "json", "metadata", "exists-error"])("does not fall through an existing primary source with %s failure", (failure) => {
    const { ctx, plugin } = setup()
    ctx.host.fs.writeText("~/.codex/auth.json", auth("old-user", "old-workspace"))
    const original = ctx.host.fs.readText
    const reads = vi.fn((path) => {
      if (path === AUTH_PATH) {
        if (failure === "permission") throw new Error("fixture permission denied")
        if (failure === "json") return "{bad"
        if (failure === "metadata") return JSON.stringify({ tokens: { access_token: { invalid: true } } })
      }
      return original(path)
    })
    ctx.host.fs.readText = reads
    if (failure === "exists-error") ctx.host.fs.existsStrict.mockImplementation(() => { throw new Error("fixture metadata denied") })
    expect(() => plugin.probeReports(ctx)).toThrow("invalid or unreadable")
    expect(reads.mock.calls.some(([path]) => path === "~/.codex/auth.json")).toBe(false)
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("uses the next local source only when the first is explicitly absent", () => {
    const { ctx, plugin } = setup()
    ctx.host.fs.existsStrict.mockImplementation((path) => path === "~/.codex/auth.json")
    ctx.host.fs.writeText("~/.codex/auth.json", auth("secondary-user", "secondary-workspace"))
    plugin.probeReports(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers["ChatGPT-Account-Id"]).toBe("secondary-workspace")
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
  })

  it("rejects a damaged primary source appearing during a report from the previously missing path", () => {
    const { ctx, plugin } = setup()
    let appeared = false
    ctx.host.fs.existsStrict.mockImplementation((path) => path === "~/.codex/auth.json" || (path === AUTH_PATH && appeared))
    ctx.host.fs.writeText("~/.codex/auth.json", auth())
    const read = ctx.host.fs.readText
    ctx.host.fs.readText = (path) => path === AUTH_PATH ? "{bad" : read(path)
    const request = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((opts) => { const result = request(opts); appeared = true; return result })
    expect(() => plugin.probeReports(ctx)).toThrow("credentials changed")
  })

})

describe("Codex report model limits", () => {
  it("caps optional models by stable name while retaining all daily totals and negative credits", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-04T00:05:00Z"))
    try {
      const { ctx, response, plugin } = setup("team")
      const models = Array.from({ length: 300 }, (_, i) => ({
        model: "model-" + String(i).padStart(3, "0"), turns: 1, text_total_tokens: 1, on_demand_credits: -1,
      })).reverse()
      response.counts.data = Array.from({ length: 30 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 9, 6 + i)).toISOString().slice(0, 10),
        totals: { turns: i === 29 ? 300 : 0, text_total_tokens: i === 29 ? 300 : 0 },
        ...(i === 29 ? { models } : {}),
      }))
      response.credits = { data: [{ date: "2026-11-04", premium_usage_values: { credit_usage_credits: { cli: -300 } }, models }] }
      const result = plugin.probeReports(ctx)
      expect(result.lines.length).toBeLessThanOrEqual(512)
      expect(result.reports.every((report) => report.status === "partial")).toBe(true)
      expect(result.reports.every((report) => /100.*models/.test(report.message))).toBe(true)
      expect(result.reports[0].coverage.missingDates).toEqual([])
      expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Tokens", value: "300 tokens" }))
      expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Turns", value: "300 turns" }))
      expect(result.lines).toContainEqual(expect.objectContaining({ label: "Reported Credits", value: "-300 credits" }))
      expect(result.lines).toContainEqual(expect.objectContaining({ label: "2026-11-04 Charged Credits", value: "-300 credits" }))
      const modelLines = result.lines.filter((line) => line.label.startsWith("Model "))
      expect(modelLines).toHaveLength(300)
      expect(modelLines[0].label).toContain("model-000")
      expect(modelLines.some((line) => line.label.endsWith("model-099"))).toBe(true)
      expect(modelLines.some((line) => line.label.endsWith("model-100"))).toBe(false)
      const first = modelLines
      response.counts.data[29].models.reverse()
      expect(plugin.probeReports(ctx).lines.filter((line) => line.label.startsWith("Model "))).toEqual(first)
    } finally { vi.useRealTimers() }
  })
})
