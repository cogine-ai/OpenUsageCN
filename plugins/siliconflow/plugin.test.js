import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

function context(config = {}, env = {}) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((key) => config[key] ?? null)
  ctx.host.env.get.mockImplementation((key) => env[key] ?? null)
  return ctx
}
function response(ctx, data, status = 200) {
  ctx.host.http.request.mockReturnValue({ status, bodyText: JSON.stringify(data) })
}
const valid = (data = {}) => ({ code: 20000, status: true, data: { totalBalance: "88.88", chargeBalance: "88.00", balance: "0.88", status: "normal", ...data } })
async function plugin() { await import("./plugin.js"); return globalThis.__openusage_plugin }

describe("SiliconFlow", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })

  it("declares regional credentials, actual brand color and a themed logo", () => {
    const manifest = JSON.parse(readFileSync("plugins/siliconflow/plugin.json", "utf8"))
    expect(manifest.brandColor).toBe("#6E29F5")
    expect(manifest.config.fields[0]).toMatchObject({ default: "auto", autoValue: "auto" })
    expect(manifest.lines.every((line) => line.type === "text")).toBe(true)
    expect(readFileSync("plugins/siliconflow/icon.svg", "utf8")).toContain('fill="currentColor"')
  })

  it("uses only the China balance GET by default, preferring the saved key", async () => {
    const ctx = context({ apiKey: "saved-key" }, { SILICONFLOW_API_KEY: "env-key" })
    response(ctx, valid())
    const output = (await plugin()).probe(ctx)
    expect(ctx.host.http.request).toHaveBeenCalledOnce()
    expect(ctx.host.http.request).toHaveBeenCalledWith({ method: "GET", url: "https://api.siliconflow.cn/v1/user/info", headers: { Authorization: "Bearer saved-key", Accept: "application/json" }, timeoutMs: 15000 })
    expect(output.lines).toContainEqual({ type: "text", label: "Balance", value: "CN¥88.88" })
    expect(output.lines).toContainEqual({ type: "text", label: "Purchased", value: "CN¥88.00" })
    expect(output.lines).toContainEqual({ type: "text", label: "Bonus", value: "CN¥0.88" })
    expect(ctx.host.env.get).not.toHaveBeenCalledWith("SILICONFLOW_API_KEY")
  })

  it("reads the environment region only for Auto and never silently switches regions", async () => {
    const ctx = context({ region: "auto" }, { SILICONFLOW_API_KEY: "env-key", SILICONFLOW_REGION: "international" })
    response(ctx, valid({ totalBalance: -1.25, chargeBalance: null, balance: null }))
    const output = (await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].url).toBe("https://api.siliconflow.com/v1/user/info")
    expect(output.lines).toContainEqual({ type: "text", label: "Balance", value: "-$1.25" })
    expect(output.lines.some((line) => line.label === "Purchased")).toBe(false)
    expect(output.lines.some((line) => line.type === "progress" || line.resetsAt)).toBe(false)
  })

  it("explicit China overrides the environment and accepts a real zero balance", async () => {
    const ctx = context({ apiKey: "key", region: "china" }, { SILICONFLOW_REGION: "international" })
    response(ctx, valid({ totalBalance: "0", status: "suspended" }))
    const output = (await plugin()).probe(ctx)
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(output.lines).toContainEqual({ type: "text", label: "Balance", value: "CN¥0.00" })
    expect(output.lines).toContainEqual({ type: "text", label: "Status", value: "suspended" })
  })

  it.each(["https://attacker.example", "unknown"])("rejects invalid region %s before any request", async (region) => {
    const ctx = context({ region, apiKey: "private-key" })
    const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Choose China or International")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it.each([null, "", "secret\nvalue"])("rejects missing or header-unsafe key", async (apiKey) => {
    const ctx = context({ apiKey })
    const p = await plugin()
    expect(() => p.probe(ctx)).toThrow("Add a valid SiliconFlow API key")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it.each([[401, "invalid"], [403, "lacks access"], [429, "rate limiting"], [410, "refused"], [503, "request failed"]])("reports HTTP %s without exposing the response", async (status, message) => {
    const ctx = context({ apiKey: "private-key" })
    response(ctx, { message: "private-body" }, status)
    const p = await plugin()
    expect(() => p.probe(ctx)).toThrow(message)
    expect(ctx.host.http.request).toHaveBeenCalledOnce()
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toMatch(/private-key|private-body/)
  })

  it.each([[30014, "invalid"], [20092, "refused"]])("handles API-level error %s", async (code, message) => {
    const ctx = context({ apiKey: "key" }); response(ctx, { code, status: false })
    const p = await plugin(); expect(() => p.probe(ctx)).toThrow(message)
  })

  it.each([{}, [], { code: 20000, status: false, data: {} }, valid({ totalBalance: "NaN" }), valid({ totalBalance: " 1 " }), valid({ totalBalance: null }), valid({ chargeBalance: true }), valid({ status: "private@example.com" })])("rejects malformed responses instead of inventing a balance", async (body) => {
    const ctx = context({ apiKey: "key" }); response(ctx, body)
    const p = await plugin(); expect(() => p.probe(ctx)).toThrow("response is invalid")
  })

  it("ignores personal fields and does not surface transport messages", async () => {
    const ctx = context({ apiKey: "key" })
    response(ctx, valid({ id: "private-id", email: "private@example.com", name: "private-name", image: "private-image" }))
    const p = await plugin()
    expect(JSON.stringify(p.probe(ctx))).not.toContain("private")
    ctx.host.http.request.mockImplementation(() => { throw new Error("private transport body") })
    expect(() => p.probe(ctx)).toThrow("Check your connection")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
  })
})
