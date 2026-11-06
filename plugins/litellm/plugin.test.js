import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const BASE = "https://gateway.example/proxy"
function context(routes = {}, config = {}, env = {}) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((key) => ({ baseUrl: BASE + "/v1/", apiKey: "private-key", ...config })[key] ?? null)
  ctx.host.env.get.mockImplementation((key) => env[key] ?? null)
  ctx.host.http.normalizeConfiguredBaseUrl = vi.fn((value) => value.trim().replace(/\/+$/, ""))
  ctx.host.http.request.mockImplementation((request) => {
    const url = new URL(request.url)
    const path = url.pathname.slice("/proxy/".length)
    const value = routes[path]
    if (value === undefined) throw new Error("Unexpected request: " + path)
    if (value instanceof Error) throw value
    if (value.http) return { status: value.http, bodyText: value.raw ?? JSON.stringify({ message: "private-response" }) }
    return { status: 200, bodyText: JSON.stringify(value) }
  })
  return ctx
}
const key = (info = {}) => ({ info: { user_id: "private-user", spend: 1, ...info } })
const user = (info = {}, teams) => ({ user_info: { user_id: "private-user", spend: 12, max_budget: 100, ...info }, ...(teams ? { teams } : {}) })
const team = (info = {}) => ({ team_info: { team_id: "private-team", spend: 20, max_budget: 200, ...info } })
async function plugin() { await import("./plugin.js"); return globalThis.__openusage_plugin }

describe("LiteLLM", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  afterEach(() => vi.restoreAllMocks())

  it("declares virtual credentials, separate monetary resources and themed icon", () => {
    const manifest = JSON.parse(readFileSync("plugins/litellm/plugin.json", "utf8"))
    expect(manifest.brandColor).toBe("#4C89F0")
    expect(manifest.config.fields.map((f) => f.id)).toEqual(["baseUrl", "apiKey"])
    expect(manifest.lines.filter((v) => v.type === "progress").map((v) => v.limitResource.key)).toEqual(["teamBudget", "memberBudget", "personalBudget"])
    expect(readFileSync("plugins/litellm/icon.svg", "utf8")).toContain("currentColor")
  })

  it("normalizes the configured gateway, strips only /v1 and prefers saved fields", async () => {
    const ctx = context({ "key/info": key(), "user/info": user({ user_email: "private@example.com", user_alias: "private-alias" }) }, {}, { LITELLM_API_KEY: "unused-key", LITELLM_BASE_URL: "https://other.example" })
    const output = (await plugin()).probe(ctx)
    expect(ctx.host.http.normalizeConfiguredBaseUrl).toHaveBeenCalledWith(BASE + "/v1/")
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.http.request.mock.calls.map(([v]) => v.url)).toEqual([BASE + "/key/info", BASE + "/user/info?user_id=private-user"])
    for (const [request] of ctx.host.http.request.mock.calls) {
      expect(request).toMatchObject({ method: "GET", headers: { Authorization: "Bearer private-key", Accept: "application/json" } })
    }
    expect(output.lines).toContainEqual({ type: "progress", label: "Personal Budget", used: 12, limit: 100, format: { kind: "dollars" } })
    expect(JSON.stringify(output)).not.toMatch(/private-|private@/)
  })

  it("uses environment fields when no saved value exists", async () => {
    const ctx = context({ "key/info": key(), "user/info": user() }, { baseUrl: "", apiKey: "" }, { LITELLM_BASE_URL: BASE, LITELLM_API_KEY: "environment-key" })
    ;(await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer environment-key")
  })

  it("does not send a key when the host rejects an unsafe endpoint", async () => {
    const ctx = context({}, { baseUrl: "http://public.example?token=private" })
    ctx.host.http.normalizeConfiguredBaseUrl.mockReturnValue(null)
    const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Proxy URL is invalid")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
  })

  it.each(["", "bad\nkey"])("rejects an absent or header-unsafe key", async (apiKey) => {
    const ctx = context({}, { apiKey }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Add a LiteLLM virtual API key")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("keeps team and personal budgets separate with the service reset date only", async () => {
    const reset = "2026-03-01T00:00:00Z"
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user({}, [{ team_id: "other", spend: 999, max_budget: 1000 }, { team_id: "private-team", spend: 20, max_budget: 200, budget_reset_at: reset }]) })
    const output = (await plugin()).probe(ctx)
    expect(output.lines.filter((v) => v.type === "progress")).toEqual([
      { type: "progress", label: "Personal Budget", used: 12, limit: 100, format: { kind: "dollars" } },
      { type: "progress", label: "Team Budget", used: 20, limit: 200, format: { kind: "dollars" }, resetsAt: "2026-03-01T00:00:00.000Z" },
    ])
    expect(output.lines.every((v) => !v.periodDurationMs)).toBe(true)
    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
  })

  it("uses the exact member spend rather than the user-wide total", async () => {
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user({ spend: 90, max_budget: null }, [{ team_id: "private-team", spend: 20, max_budget: 200,
      team_memberships: [{ user_id: "different", spend: 99, litellm_budget_table: { max_budget: 999 } }, { user_id: "private-user", team_id: "private-team", spend: 3, litellm_budget_table: { max_budget: 8 } }] }]) })
    const output = (await plugin()).probe(ctx)
    expect(output.lines).toContainEqual({ type: "progress", label: "Team Member Budget", used: 3, limit: 8, format: { kind: "dollars" } })
    expect(output.lines).toContainEqual({ type: "text", label: "Personal Spend", value: "$90.00", subtitle: "No Budget Reported" })
    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
  })

  it("retains a user-response member override while filling matching spend from team info", async () => {
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user({ spend: 90, max_budget: null }, [{ team_id: "private-team", spend: 20, max_budget: 200,
      team_memberships: [{ user_id: "private-user", litellm_budget_table: { max_budget: 8 } }] }]),
      "team/info": team({ team_memberships: [{ user_id: "private-user", team_id: "private-team", spend: 2, litellm_budget_table: { max_budget: 10 } }] }) })
    expect((await plugin()).probe(ctx).lines).toContainEqual({ type: "progress", label: "Team Member Budget", used: 2, limit: 8, format: { kind: "dollars" } })
  })

  it("uses the team member default only with that member's verified spend", async () => {
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user({ max_budget: null }),
      "team/info": team({ team_member_budget_table: { max_budget: 5 }, team_memberships: [{ user_id: "private-user", team_id: "private-team", spend: 1 }] }) })
    expect((await plugin()).probe(ctx).lines).toContainEqual({ type: "progress", label: "Team Member Budget", used: 1, limit: 5, format: { kind: "dollars" } })
  })

  it("does not create a member quota from user-wide spend when member spend is missing", async () => {
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user({ spend: 90, max_budget: null }), "team/info": team({ team_member_budget_table: { max_budget: 5 } }) })
    const output = (await plugin()).probe(ctx)
    expect(output.lines.some((v) => v.label === "Team Member Budget")).toBe(false)
    expect(output.lines).toContainEqual(expect.objectContaining({ label: "Status", value: "Some Budget Data Unavailable" }))
    expect(output.lines).toContainEqual(expect.objectContaining({ label: "Team Budget", used: 20 }))
  })

  it.each([{ http: 403 }, { http: 503 }, team({ team_id: "another-team" })])("retains personal budget and warns on unavailable optional team data", async (teamReply) => {
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user(), "team/info": teamReply })
    const output = (await plugin()).probe(ctx)
    expect(output.lines).toContainEqual(expect.objectContaining({ label: "Personal Budget", used: 12 }))
    expect(output.lines.some((v) => v.label === "Team Budget")).toBe(false)
    expect(output.lines).toContainEqual(expect.objectContaining({ label: "Status", value: "Some Budget Data Unavailable" }))
    expect(ctx.host.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not be verified"))
    expect(JSON.stringify(output)).not.toContain("another-team")
  })

  it("supports team-only keys without reading a user's data", async () => {
    const ctx = context({ "key/info": key({ user_id: null, team_id: "private-team" }), "team/info": team() })
    expect((await plugin()).probe(ctx).lines).toContainEqual(expect.objectContaining({ label: "Team Budget", used: 20, limit: 200 }))
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("user/info"))).toBe(false)
  })

  it.each([user({ user_id: "wrong" }), { user_info: { spend: 1, max_budget: 10 } }])("rejects missing or mismatched required user identity", async (body) => {
    const ctx = context({ "key/info": key(), "user/info": body }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("response is invalid")
  })

  it("rejects a mismatched team-only identity", async () => {
    const ctx = context({ "key/info": key({ user_id: null, team_id: "private-team" }), "team/info": team({ team_id: "wrong" }) }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("response is invalid")
  })

  it.each([401, 403, 404])("uses only self-scoped spend fallback when key info is unavailable (%s)", async (status) => {
    const ctx = context({ "key/info": { http: status }, "key/spend/report": [{ total_cost: 1.25, api_key: "private-response-key" }, { total_cost: 0 }] })
    const output = (await plugin()).probe(ctx)
    expect(output.lines).toContainEqual({ type: "text", label: "Key Spend", value: "$1.25", subtitle: "2026-02-01–2026-02-02 UTC" })
    expect(output.lines.some((v) => v.type === "progress")).toBe(false)
    expect(ctx.host.http.request.mock.calls[1][0].url).toBe(BASE + "/key/spend/report?start_date=2026-02-01&end_date=2026-02-02")
    expect(JSON.stringify(output)).not.toContain("private")
  })

  it("tries user-scoped reports only when key reports are explicitly unavailable", async () => {
    const ctx = context({ "key/info": { http: 403 }, "key/spend/report": { http: 404 }, "user/spend/report": [{ total_cost: 0 }] })
    const output = (await plugin()).probe(ctx)
    expect(output.lines).toContainEqual(expect.objectContaining({ label: "User Spend", value: "$0.00" }))
    expect(ctx.host.http.request.mock.calls[2][0].url).toBe(BASE + "/user/spend/report?start_date=2026-02-01&end_date=2026-02-02")
  })

  it.each([429, 503])("does not hide report failures (%s) by changing scope", async (status) => {
    const ctx = context({ "key/info": { http: 403 }, "key/spend/report": { http: status } }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow(status === 429 ? "rate limiting" : "request failed")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
  })

  it.each([[], [{ total_cost: "1" }], [{ total_cost: -1 }], [{ total_cost: 1e308 }, { total_cost: 1e308 }]])("does not invent zero spend for empty or invalid reports", async (rows) => {
    const ctx = context({ "key/info": { http: 403 }, "key/spend/report": rows }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow()
  })

  it.each([user({ spend: null }), user({ spend: "12" }), user({ max_budget: -1 })])("rejects malformed required spend/budget values", async (body) => {
    const ctx = context({ "key/info": key(), "user/info": body }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("response is invalid")
  })

  it("preserves actual zero spend without a zero denominator or invented reset", async () => {
    const ctx = context({ "key/info": key(), "user/info": user({ spend: 0, max_budget: 0, budget_reset_at: "unknown" }) })
    const output = (await plugin()).probe(ctx)
    expect(output.lines).toContainEqual({ type: "text", label: "Personal Spend", value: "$0.00", subtitle: "No Budget Reported" })
    expect(output.lines.some((v) => v.type === "progress" || v.resetsAt)).toBe(false)
  })

  it("shares one deadline across budget requests", async () => {
    const ctx = context({ "key/info": key({ team_id: "private-team" }), "user/info": user(), "team/info": team() })
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(12000).mockReturnValueOnce(24000)
    ;(await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls.map(([r]) => r.timeoutMs)).toEqual([15000, 13000, 1000])
  })

  it("does not leak transport errors or try unrelated account credentials", async () => {
    const ctx = context({ "key/info": new Error("private-key private-response") }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Check your connection")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
  })
})
