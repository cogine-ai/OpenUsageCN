import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

async function setup(body, status = 200) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((key) => ({ cookie: "session=synthetic-private", userAgent: "Synthetic Browser/1.0" })[key] ?? null)
  ctx.host.http.request.mockReturnValue({ status, bodyText: typeof body === "string" ? body : JSON.stringify(body) })
  await import("./plugin.js")
  return { ctx, plugin: globalThis.__openusage_plugin }
}

function summary(changes = {}) {
  return { code: 0, data: {
    SubscriptionPackageName: "Pro",
    Packages: [{ CapacityUnit: "credits", CycleTotalCapacity: "500", CycleRemainCapacity: "450", CycleFrozenCapacity: "5" }],
    CreditGroups: [{ Kind: "benefit", CapacityUnit: "credits", CycleTotalCapacity: "100", CycleRemainCapacity: "90" }],
    ...changes,
  } }
}

describe("WorkBuddy usage", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })

  it("declares isolated settings, numeric credits and a themeable official mark", () => {
    const manifest = JSON.parse(readFileSync("plugins/workbuddy/plugin.json", "utf8"))
    expect(manifest).toMatchObject({ id: "workbuddy", brandColor: "#0DC8A6" })
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["cookie", "userAgent"])
    expect(manifest.lines.find((line) => line.label === "Credits" && line.type === "progress").limitResource).toEqual({ key: "credits", countUnit: "credits" })
    expect(readFileSync("plugins/workbuddy/icon.svg", "utf8")).toContain('fill="currentColor"')
  })

  it("reads the fixed summary with the same explicitly supplied Cookie and User-Agent", async () => {
    const { ctx, plugin } = await setup(summary())
    expect(plugin.probe(ctx)).toMatchObject({ plan: "Pro", lines: [
      { type: "progress", label: "Credits", used: 50, limit: 500 },
      { type: "text", label: "Reserved", value: "5 credits" },
      { type: "progress", label: "Rewards", used: 10, limit: 100 },
    ] })
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.http.request.mock.calls[0][0]).toMatchObject({
      method: "POST", url: "https://www.workbuddy.cn/billing/meter/get-user-resource-summary", bodyText: "{}",
      headers: { Cookie: "session=synthetic-private", "User-Agent": "Synthetic Browser/1.0" }, timeoutMs: 15000,
    })
    expect(ctx.host.env.get).not.toHaveBeenCalled()
  })

  it("uses only declared environment values when Settings are empty", async () => {
    const { ctx, plugin } = await setup(summary())
    ctx.host.config.get.mockReturnValue(null)
    ctx.host.env.get.mockImplementation((key) => ({ WORKBUDDY_COOKIE: "env-session", WORKBUDDY_USER_AGENT: "Env Browser/2" })[key] ?? null)
    plugin.probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers).toMatchObject({ Cookie: "env-session", "User-Agent": "Env Browser/2" })
  })

  it.each(["cookie", "userAgent"])("requires %s before making a request", async (missing) => {
    const { ctx, plugin } = await setup(summary())
    ctx.host.config.get.mockImplementation((key) => key === missing ? null : "present")
    expect(() => plugin.probe(ctx)).toThrow("Cookie and matching User-Agent")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it.each(["Browser\r\nAuthorization: secret", "浏览器", "Browser\t1"])("rejects a non-single-ASCII User-Agent", async (userAgent) => {
    const { ctx, plugin } = await setup(summary())
    ctx.host.config.get.mockImplementation((key) => key === "userAgent" ? userAgent : "session=fixture")
    expect(() => plugin.probe(ctx)).toThrow("single request-header")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("does not fall back to another source when the chosen session is rejected", async () => {
    const { ctx, plugin } = await setup({}, 401)
    ctx.host.env.get.mockReturnValue("other-account")
    expect(() => plugin.probe(ctx)).toThrow("session expired or its User-Agent")
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
  })

  it.each([[403, "denied access"], [429, "rate limited"], [503, "request failed"]])("classifies HTTP %s", async (status, message) => {
    const { ctx, plugin } = await setup({}, status)
    expect(() => plugin.probe(ctx)).toThrow(message)
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it.each(["invalid json", { code: 0, data: {} }, summary({ Packages: [null] }), summary({ Packages: [{ CapacityUnit: "credits", CycleTotalCapacity: "", CycleRemainCapacity: "4" }] })])("rejects invalid required summary instead of producing zero", async (body) => {
    const { ctx, plugin } = await setup(body)
    expect(() => plugin.probe(ctx)).toThrow("response changed")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("distinguishes a provider rejection from a malformed response", async () => {
    const { ctx, plugin } = await setup({ code: 10001, data: {} })
    expect(() => plugin.probe(ctx)).toThrow("rejected the usage request")
    expect(ctx.host.log.error).toHaveBeenCalledWith("WorkBuddy usage failed: billing request rejected")
  })

  it("keeps valid overall credits when the optional rewards breakdown is invalid", async () => {
    const { ctx, plugin } = await setup(summary({ CreditGroups: [{ Kind: "benefit", CapacityUnit: "credits", CycleTotalCapacity: "bad", CycleRemainCapacity: "9" }] }))
    const output = plugin.probe(ctx)
    expect(output.lines[0]).toMatchObject({ label: "Credits", used: 50, limit: 500 })
    expect(output.lines.at(-1)).toMatchObject({ label: "Rewards", value: "Unavailable; overall Credits remain available" })
    expect(ctx.host.log.warn).toHaveBeenCalled()
  })

  it("does not invent a quota when no credit packages are returned", async () => {
    const { ctx, plugin } = await setup(summary({ Packages: [], CreditGroups: [] }))
    expect(plugin.probe(ctx).lines).toEqual([{ type: "text", label: "Credits", value: "Not reported" }])
  })

  it("retains an explicit zero-total balance and rollover without a false percentage", async () => {
    const { ctx, plugin } = await setup(summary({ Packages: [{ CapacityUnit: "credits", CycleTotalCapacity: 0, CycleRemainCapacity: 3 }], CreditGroups: [] }))
    expect(plugin.probe(ctx).lines).toEqual([{ type: "text", label: "Credits", value: "3 / 0 credits remaining" }])
  })

  it("preserves reported rollover beyond the grant instead of losing its remaining balance", async () => {
    const { ctx, plugin } = await setup(summary({ Packages: [{ CapacityUnit: "credits", CycleTotalCapacity: 100, CycleRemainCapacity: 125, CycleFrozenCapacity: 0.001 }], CreditGroups: [] }))
    expect(plugin.probe(ctx).lines).toEqual([
      { type: "progress", label: "Credits", used: 0, limit: 100, format: { kind: "count", suffix: "credits" } },
      { type: "text", label: "Credits Remaining", value: "125 credits" },
      { type: "text", label: "Reserved", value: "<0.01 credits" },
    ])
  })

  it("ignores non-credit units and never adds rewards to the overall allowance", async () => {
    const body = summary()
    body.data.Packages.push({ CapacityUnit: "other", CycleTotalCapacity: "10000", CycleRemainCapacity: "10" })
    const { ctx, plugin } = await setup(body)
    const output = plugin.probe(ctx)
    expect(output.lines[0]).toMatchObject({ used: 50, limit: 500 })
    expect(output.lines.every((line) => !line.resetsAt && !line.periodDurationMs)).toBe(true)
  })

  it("does not leak raw upstream identifiers or credentials through its errors", async () => {
    const { ctx, plugin } = await setup({ code: "private-account-id", Uin: "private-uin" })
    expect(() => plugin.probe(ctx)).toThrow("response changed")
    const logs = JSON.stringify(ctx.host.log.error.mock.calls)
    expect(logs).not.toContain("private-account")
    expect(logs).not.toContain("private-uin")
    expect(logs).not.toContain("synthetic-private")
  })

  it("turns a transport exception into a fixed, logged error", async () => {
    const { ctx, plugin } = await setup(summary())
    ctx.host.http.request.mockImplementation(() => { throw new Error("raw-private-cookie") })
    expect(() => plugin.probe(ctx)).toThrow("Check your connection")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("raw-private-cookie")
  })
})
