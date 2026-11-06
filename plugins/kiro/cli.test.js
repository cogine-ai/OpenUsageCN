import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const DATABASE = "~/Library/Application Support/kiro-cli/data.sqlite3"
const DESKTOP = "~/.aws/sso/cache/kiro-auth-token.json"
const ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/synthetic"
const reply = (body, status = 200) => ({ status, bodyText: JSON.stringify(body) })
const credits = (overrides = {}) => ({
  resourceType: "CREDIT", currentUsageWithPrecision: 120, usageLimitWithPrecision: 100,
  currentOveragesWithPrecision: 20, overageCapWithPrecision: 50, bonuses: [], nextDateReset: 1793750400,
  ...overrides,
})
const usage = (credit = credits(), extra = {}) => ({
  usageBreakdownList: [credit], subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
  overageConfiguration: { overageStatus: "ENABLED" }, ...extra,
})
async function plugin() {
  await import("./cli.js")
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}
function fixture(options = {}) {
  const ctx = makeCtx()
  ctx.nowIso = "2026-11-04T00:00:00.000Z"
  const database = options.database || DATABASE
  ctx.host.fs.writeText(database, "synthetic database marker")
  let accessToken = "synthetic-cli-account-a"
  ctx.host.sqlite.queryReadOnly = vi.fn((db, sql) => {
    expect(db).toBe(database)
    if (sql.includes("auth_kv")) return JSON.stringify([{ value: JSON.stringify({ access_token: accessToken }) }])
    expect(sql).toContain("api.codewhisperer.profile")
    return JSON.stringify(options.profile === null ? [] : [{ value: JSON.stringify(options.profile || { arn: ARN }) }])
  })
  ctx.host.sqlite.query.mockImplementation(() => { throw new Error("desktop data must not be read") })
  ctx.host.http.request.mockReturnValue(reply(usage()))
  ctx.host.fs.writeText.mockClear()
  return { ctx, switchAccount: () => { accessToken = "synthetic-cli-account-b" } }
}
function line(output, label) { return output.lines.find((item) => item.label === label) }

beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin; delete globalThis.__openusage_kiro_cli })
describe("Kiro CLI source isolation and quota pools", () => {
  it("uses read-only auth_kv and the fixed AWS JSON protocol without changing CLI credentials", async () => {
    const { ctx } = fixture()
    const output = (await plugin()).probe(ctx)
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.http.request.mock.calls[0][0]).toMatchObject({
      method: "POST", url: "https://codewhisperer.us-east-1.amazonaws.com/", timeoutMs: 10000,
      headers: { Authorization: "Bearer synthetic-cli-account-a", "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits" },
      bodyText: JSON.stringify({ profileArn: ARN }),
    })
    expect(ctx.host.sqlite.queryReadOnly.mock.calls[0][1]).toContain("kirocli:odic:token")
    expect(line(output, "Credits")).toMatchObject({ used: 100, limit: 100 })
    expect(line(output, "Overage Credits")).toMatchObject({ used: 20, limit: 50 })
    expect(line(output, "Credits").resetsAt).toBe("2026-11-04T00:00:00.000Z")
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
  })
  it("allows Builder ID without a persisted profile and sends no invented ARN", async () => {
    const { ctx } = fixture({ profile: null })
    ;(await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].bodyText).toBe("{}")
  })
  it("routes only a validated European profile to the European endpoint", async () => {
    const { ctx } = fixture({ profile: { arn: ARN.replace("us-east-1", "eu-central-1") } })
    ;(await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].url).toBe("https://q.eu-central-1.amazonaws.com/")
  })
  it.each([{}, { arn: "" }, { arn: "not-an-arn" }, { arn: ARN.replace("us-east-1", "us-west-2") }, { arn: ARN + "\n" }, { arn: ARN.replace("codewhisperer", "evil") }])("rejects a present invalid or unsupported profile: %j", async (profile) => {
    const { ctx } = fixture({ profile })
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Kiro CLI profile is invalid or its region is unsupported. Check your CLI sign-in.")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
  it.each([401, 403, 429, 503])("does not switch to desktop credentials after HTTP %i", async (status) => {
    const { ctx } = fixture()
    ctx.host.http.request.mockImplementation(() => {
      ctx.host.fs.writeText(DESKTOP, JSON.stringify({ accessToken: "different-desktop", refreshToken: "different-refresh" }))
      return reply({}, status)
    })
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow(/Kiro CLI/)
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
  })
  it("rejects a response when the CLI identity changed during the request", async () => {
    const { ctx, switchAccount } = fixture()
    ctx.host.http.request.mockImplementation(() => { switchAccount(); return reply(usage()) })
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Kiro CLI connection changed. Refresh usage.")
  })
  it("retains the selected database even when its environment path changes during refresh", async () => {
    const { ctx } = fixture({ database: "/synthetic/first/data.sqlite3" })
    let path = "/synthetic/first"
    ctx.host.env.get.mockImplementation((name) => name === "KIRO_DATA_DIR" ? path : null)
    ctx.host.http.request.mockImplementation(() => { path = "/synthetic/second"; return reply(usage()) })
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Kiro CLI connection changed. Refresh usage.")
    expect(ctx.host.sqlite.queryReadOnly.mock.calls.every(([db]) => db === "/synthetic/first/data.sqlite3")).toBe(true)
  })
  it("uses XDG data paths outside macOS", async () => {
    const { ctx } = fixture({ database: "/synthetic/xdg/kiro-cli/data.sqlite3" })
    ctx.app.platform = "linux"
    ctx.host.env.get.mockImplementation((name) => name === "XDG_DATA_HOME" ? "/synthetic/xdg" : null)
    ;(await plugin()).probe(ctx)
    expect(ctx.host.sqlite.queryReadOnly).toHaveBeenCalled()
  })
  it("does not bypass an existing unreadable desktop sign-in with a different CLI account", async () => {
    const { ctx } = fixture()
    ctx.host.fs.writeText(DESKTOP, "broken desktop credentials")
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Open Kiro and sign in, then try again.")
    expect(ctx.host.sqlite.queryReadOnly).not.toHaveBeenCalled()
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
  it("does not manufacture a plan pool when API usage includes bonuses", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits({ currentUsageWithPrecision: 150, bonuses: [{ currentUsage: 30, usageLimit: 50 }] }))))
    const output = (await plugin()).probe(ctx)
    expect(line(output, "Credits")).toMatchObject({ type: "badge", text: "Usage unavailable" })
    expect(line(output, "Bonus Credits")).toMatchObject({ used: 30, limit: 50 })
    expect(line(output, "Overage Credits")).toMatchObject({ used: 20, limit: 50 })
  })
  it("retains a valid overage amount over its cap without clamping it", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits({ currentUsageWithPrecision: 160, currentOveragesWithPrecision: 60 }))))
    expect(line((await plugin()).probe(ctx), "Overage Credits")).toMatchObject({ used: 60, limit: 50 })
  })
  it("does not invent zero overage from a missing amount or disabled status from an unknown status", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits({ currentUsageWithPrecision: 20, currentOveragesWithPrecision: undefined }))))
    let output = (await plugin()).probe(ctx)
    expect(line(output, "Overage Credits")).toMatchObject({ type: "text", value: "Unavailable" })
    expect(line(output, "Credits")).toMatchObject({ type: "badge", text: "Usage unavailable" })
    ctx.host.http.request.mockReturnValue(reply(usage(credits(), { overageConfiguration: { overageStatus: "FUTURE" } })))
    output = globalThis.__openusage_plugin.probe(ctx)
    expect(line(output, "Overages")).toBeUndefined()
    expect(line(output, "Overage Credits")).toMatchObject({ type: "text", value: "20 credits used; limit not reported" })
  })
  it.each([
    { currentUsageWithPrecision: "120" }, { usageLimitWithPrecision: -1 }, { currentOveragesWithPrecision: 121 },
    { currentOveragesWithPrecision: -1 }, { overageCapWithPrecision: "50" }, { bonuses: {} },
    { nextDateReset: 1793750400000 },
  ])("rejects invalid external quota scalars: %j", async (invalid) => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits(invalid))))
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Kiro CLI usage data is incomplete. Try again later.")
  })
  it("rejects a late CLI result if a desktop account became the preferred source", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockImplementation(() => {
      ctx.host.fs.writeText(DESKTOP, JSON.stringify({ accessToken: "different-desktop", refreshToken: "different-refresh" }))
      return reply(usage())
    })
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Kiro connection changed. Refresh usage.")
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
  })
  it("preserves a reported zero cap without calling it an unreported cap", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits({ overageCapWithPrecision: 0 }))))
    const output = (await plugin()).probe(ctx)
    expect(line(output, "Overage Credits")).toMatchObject({ type: "text", value: "20 / 0 credits" })
  })

  it("keeps bonus expiry separate from quota resets and pace metadata", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits({
      currentUsageWithPrecision: 150,
      bonuses: [{ currentUsage: 30, usageLimit: 50, expiresAt: "2026-11-07T00:30:00Z" }],
    }))))
    const output = (await plugin()).probe(ctx)
    expect(line(output, "Bonus Credits")).not.toHaveProperty("resetsAt")
    expect(line(output, "Bonus Expiry")).toMatchObject({ type: "text", value: "2026-11-07T00:30:00.000Z" })
    expect(line(output, "Credits").type).toBe("badge")
    expect(line(output, "Overage Credits").resetsAt).toBe("2026-11-04T00:00:00.000Z")
  })

  it("does not mistake an unreadable desktop path for absence and select another CLI account", async () => {
    const { ctx } = fixture()
    ctx.host.fs.existsStrict.mockImplementation((path) => {
      if (path === DESKTOP) throw new Error("synthetic permission error")
      return ctx.host.fs.exists(path)
    })
    const loaded = await plugin()
    expect(() => loaded.probe(ctx)).toThrow("Could not verify Kiro desktop sign-in. Check file access and try again.")
    expect(ctx.host.sqlite.queryReadOnly).not.toHaveBeenCalled()
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("keeps an explicitly reported zero overage distinct from a missing amount", async () => {
    const { ctx } = fixture()
    ctx.host.http.request.mockReturnValue(reply(usage(credits({ currentUsageWithPrecision: 20, currentOveragesWithPrecision: 0 }))))
    const output = (await plugin()).probe(ctx)
    expect(line(output, "Credits")).toMatchObject({ type: "progress", used: 20, limit: 100 })
    expect(line(output, "Overage Credits")).toMatchObject({ type: "progress", used: 0, limit: 50 })
  })

})
