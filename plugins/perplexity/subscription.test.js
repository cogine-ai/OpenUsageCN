import { describe, expect, it } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"

const payload = (fields = {}) => ({ balance_cents: 900, renewal_date_ts: 1772323200, current_period_purchased_cents: 500, total_usage_cents: 1300,
  credit_grants: [{ type: "recurring", amount_cents: 1000 }, { type: "purchased", amount_cents: 500 }, { type: "promotional", amount_cents: 200, expires_at_ts: 1772323200 }], org_pool_draws_cents: 100, org_user_cap_cents: 800, ...fields })
function context(data = payload(), cookie = "__Secure-authjs.session-token=fixture-session") {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((name) => ({ source: "webSubscription", webCookie: cookie })[name] ?? null)
  ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(data) })
  return ctx
}
describe("Perplexity website subscription credits", () => {
  it("separates personal pools, total organization available balance and member cap; never calls the desktop API", () => {
    const ctx = context(), result = loadTestPlugin("perplexity").probe(ctx)
    expect(result.lines.filter((l) => l.type === "progress").map((l) => [l.label, l.used, l.limit])).toEqual([
      ["Subscription Credits", 1000, 1000], ["Purchased Credits", 300, 500], ["Promotional Credits", 0, 200], ["Organization Credits", 100, 600],
    ])
    expect(result.lines.find((l) => l.label === "Member Cap Remaining").value).toBe("700 credits")
    expect(result.lines.every((l) => l.label !== "API credits")).toBe(true)
    expect(result.lines[0].format).toEqual({ kind: "count", suffix: "credits" })
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.http.request.mock.calls[0][0]).toMatchObject({ method: "GET", url: "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default", headers: { Cookie: "__Secure-authjs.session-token=fixture-session" } })
  })
  it("deduplicates purchased allowances and excludes expired promotional grants", () => {
    const ctx = context(payload({ current_period_purchased_cents: 700, total_usage_cents: 1100, credit_grants: [{ type: "recurring", amount_cents: 1000 }, { type: "purchased", amount_cents: 500 }, { type: "promotional", amount_cents: 9999, expires_at_ts: 1 }] }))
    const lines = loadTestPlugin("perplexity").probe(ctx).lines
    expect(lines.find((l) => l.label === "Purchased Credits")).toMatchObject({ used: 100, limit: 700 })
    expect(lines.some((l) => l.label === "Promotional Credits")).toBe(false)
    expect(lines.find((l) => l.label === "Organization Credits").limit).toBe(400)
  })
  it("renders an exhausted organization without confusing a member cap with available credits", () => {
    const ctx = context(payload({ is_org_pool_depleted: true }))
    const org = loadTestPlugin("perplexity").probe(ctx).lines.find((l) => l.label === "Organization Credits")
    expect(org).toMatchObject({ used: 100, limit: 100 })
  })
  it("represents zero pools as unavailable credits, without a fabricated progress bar", () => {
    const ctx = context({ balance_cents: 0, renewal_date_ts: 0, current_period_purchased_cents: 0, total_usage_cents: 0, credit_grants: [] })
    expect(loadTestPlugin("perplexity").probe(ctx).lines).toEqual([{ type: "text", label: "Subscription Credits", value: "No Credits Available" }])
  })
  it("accepts camelCase fields and keeps promotions on their actual expiry", () => {
    const ctx = context({ balanceCents: 10, renewalDateTs: 1772323200, currentPeriodPurchasedCents: 0, totalUsageCents: 2, creditGrants: [{ type: "promotional", amountCents: 10, expiresAtTs: 1772323200 }] })
    expect(loadTestPlugin("perplexity").probe(ctx).lines[0]).toMatchObject({ label: "Promotional Credits", used: 2, limit: 10, resetsAt: "2026-03-01T00:00:00.000Z" })
  })
  it("reassembles a contiguous chunked auth cookie and sends only the session credential", () => {
    const ctx = context(payload(), "theme=dark; __Secure-next-auth.session-token.1=def; __Secure-next-auth.session-token.0=abc")
    loadTestPlugin("perplexity").probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers.Cookie).toBe("__Secure-next-auth.session-token=abcdef")
  })
  it.each(["theme=dark", "authjs.session-token.1=missingfirst", "authjs.session-token.0=a; authjs.session-token.2=missingmiddle", "authjs.session-token=a; authjs.session-token=b", "authjs.session-token=a\nHeader=b"])("rejects absent/ambiguous/incomplete sessions before HTTP", (cookie) => {
    const ctx = context(payload(), cookie)
    expect(() => loadTestPlugin("perplexity").probe(ctx)).toThrow(/Cookie|chunks/)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
  it.each([[401, "expired"], [403, "denied"], [429, "HTTP 429"], [500, "HTTP 500"]])("does not switch source after HTTP %s and logs no response secrets", (status, message) => {
    const ctx = context();ctx.host.http.request.mockReturnValue({ status, bodyText: "PRIVATE_RESPONSE" })
    expect(() => loadTestPlugin("perplexity").probe(ctx)).toThrow(message)
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("PRIVATE_RESPONSE")
  })
  it.each([payload({ balance_cents: "900" }), payload({ total_usage_cents: -1 }), payload({ credit_grants: null }), payload({ is_org_pool_depleted: "true" }), payload({ org_user_cap_cents: -1 })])("fails on malformed account-boundary data without fallback", (data) => {
    const ctx = context(data)
    expect(() => loadTestPlugin("perplexity").probe(ctx)).toThrow("invalid")
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
  })
  it("does not propagate credential-bearing JSON parse errors", () => {
    const ctx = context();ctx.host.http.request.mockReturnValue({ status: 200, bodyText: '{"token":"SECRET"' })
    expect(() => loadTestPlugin("perplexity").probe(ctx)).toThrow("invalid subscription data")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("SECRET")
  })
})
