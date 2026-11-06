import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const ORIGIN = "https://platform.claude.com"
const COOKIE = "sessionKey=private-session"
function credits(overrides = {}) {
  return { amount: 12345, currency: "USD", balance: { credits: { exponent: 2 } },
    promo_tranches: [{ name: "private-name", program_id: "subscription_api_credit", granted_amount_minor_units: 20000, remaining_amount_minor_units: 12475, expires_at: "2026-02-04T00:00:00Z" }],
    tranches: [{ granted_amount_minor_units: 5000, remaining_amount_minor_units: 2500, expires_at: "2026-02-05T00:00:00Z" }], ...overrides }
}
function context(config = {}, options = {}) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((key) => ({ cookieHeader: COOKIE, ...config })[key] ?? null)
  ctx.host.env.get.mockImplementation((key) => options.env?.[key] ?? null)
  ctx.host.http.request.mockImplementation((request) => {
    const path = request.url.slice(ORIGIN.length)
    if (path === "/api/organizations") return { status: options.orgStatus ?? 200, bodyText: JSON.stringify(options.orgs ?? [{ uuid: "private-org", name: "private-company", capabilities: ["api"] }]) }
    if (path.endsWith("/prepaid/credits")) return { status: options.creditStatus ?? 200, bodyText: JSON.stringify(options.credits ?? credits()) }
    if (path.endsWith("/current_spend")) return { status: options.spendStatus ?? 200, bodyText: options.spendRaw ?? JSON.stringify(options.spend ?? { amount: 250 }) }
    throw new Error("Unexpected request")
  })
  return ctx
}
async function plugin() { await import("./plugin.js"); return globalThis.__openusage_plugin }

describe("Claude Platform", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })

  it("has a separate namespace, secret organization selector and themeable icon", () => {
    const manifest = JSON.parse(readFileSync("plugins/claude-platform/plugin.json", "utf8"))
    expect(manifest).toMatchObject({ id: "claude-platform", brandColor: "#CC7C5E" })
    expect(manifest.config.fields.find((f) => f.id === "organizationId").type).toBe("secret")
    expect(readFileSync("plugins/claude-platform/icon.svg", "utf8")).toContain('fill="currentColor"')
  })

  it("reads one explicit Console scope and keeps grants separate from the total balance", async () => {
    const ctx = context({ cookieHeader: "Cookie: " + COOKIE + "; analytics=fixture" })
    const output = (await plugin()).probe(ctx)
    expect(output.lines).toContainEqual({ type: "text", label: "Prepaid Balance", value: "$123.45" })
    expect(output.lines).toContainEqual({ type: "text", label: "This Month Spend", value: "$2.50", subtitle: "UTC" })
    const credit = output.lines.find((line) => line.label === "API Credit")
    expect(credit.used).toBeCloseTo(37.625)
    expect(output.lines).toContainEqual({ type: "text", label: "API Credit Remaining", value: "$124.75 / $200.00", subtitle: "Expires 2026-02-04 (UTC)" })
    expect(output.lines.find((line) => line.label === "Purchased Credit").used).toBe(50)
    expect(output.lines.every((line) => !line.resetsAt && !line.periodDurationMs)).toBe(true)
    expect(JSON.stringify(output)).not.toMatch(/private-|private@/)
    expect(ctx.host.http.request.mock.calls.map(([r]) => r.url)).toEqual([
      ORIGIN + "/api/organizations", ORIGIN + "/api/organizations/private-org/prepaid/credits", ORIGIN + "/api/organizations/private-org/current_spend",
    ])
    for (const [request] of ctx.host.http.request.mock.calls) {
      expect(request.method).toBe("GET")
      expect(request.headers.Cookie).toBe(COOKIE + "; analytics=fixture")
    }
    expect(ctx.host.env.get).not.toHaveBeenCalledWith("CLAUDE_PLATFORM_COOKIE")
  })

  it("uses environment credentials only when the matching saved fields are absent", async () => {
    const ctx = context({ cookieHeader: "", organizationId: "" }, { env: { CLAUDE_PLATFORM_COOKIE: COOKIE, CLAUDE_PLATFORM_ORGANIZATION_ID: "private-org" } })
    expect((await plugin()).probe(ctx).lines.length).toBeGreaterThan(0)
    expect(ctx.host.env.get).toHaveBeenCalledWith("CLAUDE_PLATFORM_COOKIE")
    expect(ctx.host.env.get).toHaveBeenCalledWith("CLAUDE_PLATFORM_ORGANIZATION_ID")
  })

  it.each(["", "session=wrong", "sessionKey=", "sessionKey=value\nX-Injected=secret"])("rejects an unusable Cookie before reading any organization", async (cookieHeader) => {
    const ctx = context({ cookieHeader }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Cookie header containing sessionKey")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("requires an explicit choice for multiple API organizations", async () => {
    const ctx = context({}, { orgs: [{ uuid: "one", capabilities: ["api"] }, { uuid: "two", capabilities: ["api"] }] })
    const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Multiple Claude Platform API organizations")
    expect(ctx.host.http.request).toHaveBeenCalledOnce()
  })

  it("uses only the configured API organization and ignores chat-only organizations", async () => {
    const ctx = context({ organizationId: "two" }, { orgs: [{ uuid: "chat", capabilities: ["chat"] }, { uuid: "one", capabilities: ["api"] }, { uuid: "two", capabilities: ["api"] }] })
    ;(await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[1][0].url).toBe(ORIGIN + "/api/organizations/two/prepaid/credits")
    expect(ctx.host.http.request.mock.calls[2][0].url).toBe(ORIGIN + "/api/organizations/two/current_spend")
  })

  it.each([["other", "unavailable"], ["../other", "Organization ID is invalid"]])("does not substitute another organization for %s", async (organizationId, message) => {
    const ctx = context({ organizationId }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow(message)
    expect(ctx.host.http.request).toHaveBeenCalledOnce()
  })

  it.each([[403, undefined, "session expired"], [200, 403, "billing access was denied"], [429, undefined, "rate limiting"]])("distinguishes organization authentication from billing permissions", async (orgStatus, creditStatus, message) => {
    const ctx = context({}, { orgStatus, creditStatus }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow(message)
    expect(ctx.host.http.request.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it.each([401, 403, 429, 503])("retains verified credits when optional spend returns HTTP %s", async (spendStatus) => {
    const ctx = context({}, { spendStatus }); const output = (await plugin()).probe(ctx)
    expect(output.lines.find((line) => line.label === "Prepaid Balance").value).toBe("$123.45")
    expect(output.lines.find((line) => line.label === "This Month Spend").value).toBe("Unavailable")
    expect(ctx.host.log.warn).toHaveBeenCalledWith(expect.stringContaining("balance retained"))
  })

  it("retains credits on a malformed optional report without leaking the response", async () => {
    const ctx = context({}, { spendRaw: "private-response" })
    expect((await plugin()).probe(ctx).lines.find((line) => line.label === "This Month Spend").value).toBe("Unavailable")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
  })

  it("preserves non-USD precision, zero spend and a negative total balance", async () => {
    const ctx = context({}, { credits: credits({ amount: -1234, currency: "JPY", balance: { credits: { exponent: 0 } }, promo_tranches: [], tranches: [] }), spend: { amount: 0 } })
    expect((await plugin()).probe(ctx).lines).toContainEqual({ type: "text", label: "Prepaid Balance", value: "-JPY 1234" })
    expect(globalThis.__openusage_plugin.probe(ctx).lines).toContainEqual({ type: "text", label: "This Month Spend", value: "JPY 0", subtitle: "UTC" })
  })

  it.each([0, 4])("accepts declared precision %s", async (exponent) => {
    const ctx = context({}, { credits: credits({ balance: { credits: { exponent } } }) })
    expect((await plugin()).probe(ctx).lines[0].value).toBe(exponent === 0 ? "$12345" : "$1.2345")
  })

  it.each([5, -1, "2", true])("rejects unsupported currency exponent %s", async (exponent) => {
    const ctx = context({}, { credits: credits({ balance: { credits: { exponent } } }) }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("response is invalid")
  })

  it("omits expired credit, moves exhausted subscription to details and keeps exhausted purchased credit", async () => {
    const ctx = context({}, { credits: credits({
      promo_tranches: [{ program_id: "subscription_api_credit", granted_amount_minor_units: 100, remaining_amount_minor_units: 0, expires_at: "2026-03-01T00:00:00Z" }, { granted_amount_minor_units: 100, remaining_amount_minor_units: 50, expires_at: "2026-02-01T00:00:00Z" }],
      tranches: [{ granted_amount_minor_units: 100, remaining_amount_minor_units: 0, expires_at: "2026-03-02T00:00:00Z" }],
    }) })
    const output = (await plugin()).probe(ctx)
    expect(output.lines.some((line) => line.label === "API Credit")).toBe(false)
    expect(output.lines.find((line) => line.label === "Purchased Credit").used).toBe(100)
    expect(output.lines.find((line) => line.label === "Other Credit Grants").value).toContain("1 unexpired grants")
  })

  it("keeps unknown grant expiry unknown rather than inventing a reset", async () => {
    const ctx = context({}, { credits: credits({ tranches: [{ granted_amount_minor_units: 100, remaining_amount_minor_units: 50, expires_at: "unknown" }] }) })
    const line = (await plugin()).probe(ctx).lines.find((v) => v.label === "Purchased Credit Remaining")
    expect(line.subtitle).toContain("Expiry Unavailable")
    expect(line.resetsAt).toBeUndefined()
    expect(ctx.host.log.warn).toHaveBeenCalledWith(expect.stringContaining("expiry is unavailable"))
  })

  it.each([credits({ amount: "123" }), credits({ amount: 1e16 }), credits({ currency: "usd" }), credits({ promo_tranches: {} }), credits({ balance: [] })])("rejects malformed required billing data", async (body) => {
    const ctx = context({}, { credits: body }); const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("response is invalid")
  })

  it("does not leak private transport errors or invoke other credential sources", async () => {
    const ctx = context(); ctx.host.http.request.mockImplementation(() => { throw new Error("private-session private-response") })
    const p = await plugin(); expect(() => p.probe(ctx)).toThrow("Check your connection")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
  })
})
