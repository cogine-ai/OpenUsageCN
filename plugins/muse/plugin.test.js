import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

function account(changes = {}) {
  return { is_subs_active: true, subs_tier_name: "Power Usage", user_email: "private-member@example.invalid", api_key: "LLM|private-model-key", subs_usage: { window: { used_percent: 42, resets_at: 1794000000 }, weekly: { used_percent: 18 } }, ...changes }
}

async function setup(body = account(), status = 200) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((key) => key === "accessToken" ? "dca:synthetic-private" : null)
  ctx.host.http.request.mockReturnValue({ status, bodyText: typeof body === "string" ? body : JSON.stringify(body) })
  await import("./plugin.js")
  return { ctx, plugin: globalThis.__openusage_plugin }
}

describe("Muse Code usage", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })

  it("declares native-login quota metrics and a themeable brand mark", () => {
    const manifest = JSON.parse(readFileSync("plugins/muse/plugin.json", "utf8"))
    expect(manifest).toMatchObject({ id: "muse", name: "Muse Code", brandColor: "#0064E0" })
    expect(manifest.lines.filter((line) => line.limitResource).map((line) => line.limitResource.key)).toEqual(["session", "weekly"])
    expect(readFileSync("plugins/muse/icon.svg", "utf8")).toContain('fill="currentColor"')
  })

  it("reads the exact Muse account endpoint with only the native access token", async () => {
    const { ctx, plugin } = await setup()
    expect(plugin.probe(ctx)).toMatchObject({ plan: "Power Usage", lines: [
      { label: "Session", used: 42, limit: 100, periodDurationMs: 18000000, resetsAt: new Date(1794000000000).toISOString() },
      { label: "Weekly", used: 18, limit: 100, periodDurationMs: 604800000 },
    ] })
    expect(ctx.host.http.request).toHaveBeenCalledWith({
      method: "POST", url: "https://api.meta.ai/muse-code/key",
      headers: { Authorization: "Bearer dca:synthetic-private", Accept: "application/json", "Content-Type": "application/json", "x-api-version": "1.0.0" },
      bodyText: '{"onboard":false}', timeoutMs: 15000,
    })
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
  })

  it("requires Meta sign-in instead of falling back to an API-key environment", async () => {
    const { ctx, plugin } = await setup()
    ctx.host.config.get.mockReturnValue(null)
    ctx.host.env.get.mockReturnValue("LLM|inference-key")
    expect(() => plugin.probe(ctx)).toThrow("Connect Muse Code with Meta")
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it.each(["LLM|inference-key", "dca:bad\r\nheader"])("rejects an inference key or malformed access token", async (token) => {
    const { ctx, plugin } = await setup()
    ctx.host.config.get.mockReturnValue(token)
    expect(() => plugin.probe(ctx)).toThrow("connection is invalid")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it.each(["not-a-date", "1794000000", "2026-02-02T00:00:00Z"])("rejects malformed or expired native expiry %s", async (expiry) => {
    const { ctx, plugin } = await setup()
    ctx.host.config.get.mockImplementation((key) => key === "accessToken" ? "dca:fixture" : expiry)
    expect(() => plugin.probe(ctx)).toThrow(/connection is invalid|session expired/)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("accepts a future explicit UTC expiry without deriving an opaque-token expiry", async () => {
    const { ctx, plugin } = await setup()
    ctx.host.config.get.mockImplementation((key) => key === "accessToken" ? "dca:fixture" : "2026-12-01T00:00:00+00:00")
    expect(plugin.probe(ctx).lines).toHaveLength(2)
  })

  it("treats an inactive subscription as a valid connection with unavailable quota", async () => {
    const { ctx, plugin } = await setup(account({ is_subs_active: false }))
    expect(plugin.probe(ctx).lines).toEqual([{ type: "badge", label: "Subscription", text: "Unavailable", color: "#d97706" }])
  })

  it("marks unreported windows unavailable instead of manufacturing zeros", async () => {
    const { ctx, plugin } = await setup(account({ subs_usage: null }))
    expect(plugin.probe(ctx).lines).toEqual([{ type: "text", label: "Usage", value: "Quota usage was not reported" }])
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(account({ subs_usage: { weekly: { used_percent: 130.5 } } })) })
    const output = plugin.probe(ctx)
    expect(output.lines[0]).toMatchObject({ label: "Weekly", used: 130.5 })
    expect(output.lines.at(-1)).toEqual({ type: "text", label: "Usage", value: "Some quota windows were not reported" })
    expect(output.lines.some((line) => line.label === "Session")).toBe(false)
  })

  it.each(["bad-json", account({ is_subs_active: "true" }), account({ subs_usage: "bad" }), account({ subs_usage: { window: {} } }), account({ subs_usage: { window: { used_percent: -1 } } }), account({ subs_usage: { weekly: { used_percent: 5, resets_at: "tomorrow" } } })])("rejects invalid response fields without exposing the model key", async (body) => {
    const { ctx, plugin } = await setup(body)
    expect(() => plugin.probe(ctx)).toThrow("response changed")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
  })

  it.each([[401, "session expired"], [403, "denied access"], [429, "rate limited"], [503, "request failed"]])("classifies HTTP %s without reading another source", async (status, message) => {
    const { ctx, plugin } = await setup(account(), status)
    expect(() => plugin.probe(ctx)).toThrow(message)
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
  })

  it("keeps subscriber identity and the returned model API key out of output and storage", async () => {
    const { ctx, plugin } = await setup()
    expect(JSON.stringify(plugin.probe(ctx))).not.toContain("private")
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
    ctx.host.http.request.mockImplementation(() => { throw new Error("dca:private-member") })
    expect(() => plugin.probe(ctx)).toThrow("Check your connection")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private-member")
  })
})
