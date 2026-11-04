import { describe, expect, it } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"

const balance = { included: { allowance_usd: 60, balance_usd: 52.5, period: { from: "2026-01-15T00:00:00Z", until: "2026-02-15T00:00:00Z" }, session: { remaining_percent: 80 } }, purchased: { balance_usd: 12 } }
function context(config = {}) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((name) => ({ source: "apiKey", apiKey: "fixture-key", ...config })[name] ?? null)
  ctx.host.http.request.mockImplementation((req) => ({ status: 200, bodyText: JSON.stringify(req.url.endsWith("/api/me") ? { Plan: "pro", Email: "synthetic@example.invalid" } : balance) }))
  return ctx
}
describe("Ollama JSON quota", () => {
  it("uses API key JSON, actual billing duration and separate purchased balance without requesting history", () => {
    const ctx = context(), result = loadTestPlugin("ollama").probe(ctx)
    expect(result.plan).toBe("Pro")
    expect(result.lines[0]).toMatchObject({ label: "Monthly", used: 7.5, limit: 60, format: { kind: "dollars" }, periodDurationMs: 31 * 86400000 })
    expect(result.lines.find((l) => l.label === "Purchased Credits").value).toBe("$12.00")
    expect(ctx.host.http.request.mock.calls.map(([req]) => [req.method, req.url])).toEqual([["GET", "https://ollama.com/api/balance"], ["POST", "https://ollama.com/api/me"]])
    expect(ctx.host.http.request.mock.calls[0][0].headers).toEqual({ Authorization: "Bearer fixture-key", Accept: "application/json" })
  })
  it("keeps documented purchased balance when the included monthly allowance is zero", () => {
    const ctx = context(), body = { included: { allowance_usd: 0, balance_usd: 0, period: { from: "2026-01-15T00:00:00Z", until: "2026-02-15T00:00:00Z" } }, purchased: { balance_usd: 25 } }
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((req) => req.url.endsWith("/api/balance") ? { status: 200, bodyText: JSON.stringify(body) } : original(req))
    expect(loadTestPlugin("ollama").probe(ctx).lines).toEqual([{ type: "text", label: "Purchased Credits", value: "$25.00" }])
  })
  it.each([null, {}, { allowance_usd: 0 }])("does not use purchased balance to hide a malformed included shape (%s)", (included) => {
    const ctx = context();ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ included, purchased: { balance_usd: 25 } }) })
    expect(() => loadTestPlugin("ollama").probe(ctx)).toThrow("no supported usage")
  })
  it.each([403, "network"])("keeps readable quota and warns visibly when optional account details fail (%s)", (failure) => {
    const ctx = context(), original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((req) => {
      if (!req.url.endsWith("/api/me")) return original(req)
      if (failure === "network") throw Error("PRIVATE_TRANSPORT_ERROR")
      return { status: failure, bodyText: "PRIVATE_ACCOUNT_BODY" }
    })
    const result = loadTestPlugin("ollama").probe(ctx)
    expect(result.lines.find((line) => line.label === "Monthly")).toMatchObject({ used: 7.5, limit: 60 })
    expect(result.lines.find((line) => line.label === "Purchased Credits").value).toBe("$12.00")
    expect(result.lines.find((line) => line.label === "Account Details")).toMatchObject({ type: "text", value: "Unavailable" })
    expect(result.plan).toBeUndefined()
    expect(ctx.host.log.warn).toHaveBeenCalledWith("Ollama account plan details unavailable; quota remains available")
    expect(JSON.stringify([...ctx.host.log.warn.mock.calls, ...ctx.host.log.error.mock.calls])).not.toContain("PRIVATE_")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
  })
  it("loads the documented environment key only for the selected API source", () => {
    const ctx = context({ apiKey: null });ctx.host.env.get.mockReturnValue("environment-key")
    loadTestPlugin("ollama").probe(ctx)
    expect(ctx.host.env.get).toHaveBeenCalledWith("OLLAMA_API_KEY")
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer environment-key")
  })
  it.each([[401, "expired"], [403, "denied"], [429, "rate limit"], [500, "HTTP 500"]])("classifies HTTP %s without switching to Cookie or disclosing response", (status, text) => {
    const ctx = context({ cookieHeader: "session=other-account" })
    ctx.host.http.request.mockReturnValue({ status, bodyText: "SENSITIVE_RESPONSE" })
    expect(() => loadTestPlugin("ollama").probe(ctx)).toThrow(text)
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("SENSITIVE_RESPONSE")
  })
  it.each([{}, { included: { allowance_usd: -1, balance_usd: 10 } }, { included: { monthly: {} } }])("rejects missing/invalid limits rather than manufacturing zero usage", (body) => {
    const ctx = context();ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(body) })
    expect(() => loadTestPlugin("ollama").probe(ctx)).toThrow("no supported usage")
  })
  it("handles old session/weekly JSON without fabricating a monthly allowance", () => {
    const ctx = context();ctx.host.http.request.mockImplementation((req) => ({ status: 200, bodyText: JSON.stringify(req.url.endsWith("/api/me") ? { plan: "free" } : { included: { weekly: { remaining_percent: 35 }, session: { remaining_percent: 90 } } }) }))
    expect(loadTestPlugin("ollama").probe(ctx).lines.map((l) => [l.label, l.used])).toEqual([["Session", 10], ["Weekly", 65]])
  })
  it("rejects invalid selected key before any request without trying Cookie", () => {
    const ctx = context({ apiKey: "bad\nkey", cookieHeader: "session=fixture" })
    expect(() => loadTestPlugin("ollama").probe(ctx)).toThrow("invalid")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
})
