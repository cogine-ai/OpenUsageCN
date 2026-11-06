import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const TOKEN_PATH = "~/.aws/sso/cache/kiro-auth-token.json"
const PROFILE_PATH = "~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json"
const LOG_PATH = "~/Library/Application Support/Kiro/logs/session/window/exthost/kiro.kiroAgent/q-client.log"
const PROFILE_B = "arn:aws:codewhisperer:us-east-1:123456789012:profile/synthetic-b"
const reply = (body, status = 200) => ({ status, bodyText: JSON.stringify(body) })
const loadPlugin = async () => { await import("./cli.js"); await import("./plugin.js"); return globalThis.__openusage_plugin }
const makeToken = (overrides = {}) => ({
  accessToken: "synthetic-account-b", refreshToken: "synthetic-refresh-b", expiresAt: "2026-02-02T01:00:00.000Z",
  authMethod: "social", provider: "Google", profileArn: PROFILE_B, ...overrides,
})
const credits = (changes = {}) => ({
  resourceType: "CREDIT", currentUsageWithPrecision: 60, usageLimitWithPrecision: 100,
  currentOveragesWithPrecision: 0, overageCapWithPrecision: 50, bonuses: [], nextDateReset: "2026-05-01T00:00:00.000Z", ...changes,
})
const usage = (credit = credits()) => ({
  usageBreakdownList: [credit], subscriptionInfo: { subscriptionTitle: "KIRO B" }, overageConfiguration: { overageStatus: "DISABLED" },
})
const writeToken = (ctx, token = makeToken()) => ctx.host.fs.writeText(TOKEN_PATH, JSON.stringify(token))
function staleAccountA(ctx) {
  const oldCredit = { type: "CREDIT", currentUsage: 20, usageLimit: 100 }
  ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: JSON.stringify({
    "kiro.resourceNotifications.usageState": { timestamp: Date.parse(ctx.nowIso), usageBreakdowns: [oldCredit] },
  }) }]))
  ctx.host.fs.writeText(LOG_PATH, "2026-02-02 00:00:00.000 [info] " + JSON.stringify({
    commandName: "GetUsageLimitsCommand", input: { profileArn: PROFILE_B.replace("synthetic-b", "synthetic-a") },
    output: usage(credits({ currentUsageWithPrecision: 20 })),
  }))
  const read = vi.spyOn(ctx.host.fs, "readText"), list = vi.spyOn(ctx.host.fs, "listDir")
  ctx.host.fs.writeText.mockClear()
  return () => {
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(read.mock.calls.every(([path]) => path === TOKEN_PATH || path === PROFILE_PATH)).toBe(true)
  }
}
function line(output, label) { return output.lines.find((item) => item.label === label) }
beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })

describe("Kiro Desktop Credential-Bound Usage", () => {
  it("throws when auth token is missing", async () => {
    const plugin = await loadPlugin()
    expect(() => plugin.probe(makeCtx())).toThrow("Open Kiro and sign in, then try again.")
  })
  it("reads B's live 60 instead of fresh unbound A cache and logs containing 20", async () => {
    const ctx = makeCtx(); writeToken(ctx); const assertNoUnboundRead = staleAccountA(ctx)
    ctx.host.http.request.mockImplementation((request) => {
      expect(request.headers.Authorization).toBe("Bearer synthetic-account-b")
      expect(request.url).toContain(encodeURIComponent(PROFILE_B))
      return reply(usage())
    })
    const result = (await loadPlugin()).probe(ctx)
    expect(line(result, "Credits")).toMatchObject({ used: 60, limit: 100 })
    expect(result.plan).toBe("Kiro B"); assertNoUnboundRead()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
  })
  it.each([503, 401, "network", "invalid-json", "empty-usage"])("never returns A's local 20 when B's live request fails: %s", async (failure) => {
    const ctx = makeCtx(); writeToken(ctx); const assertNoUnboundRead = staleAccountA(ctx)
    ctx.host.http.request.mockImplementation(() => {
      if (failure === "network") throw new Error("PRIVATE_NETWORK_ERROR")
      if (failure === "invalid-json") return { status: 200, bodyText: "PRIVATE_INVALID_JSON" }
      if (failure === "empty-usage") return reply({ usageBreakdownList: [] })
      return reply({}, failure)
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(/Kiro (?:session expired|usage)/)
    assertNoUnboundRead()
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("PRIVATE_")
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("PRIVATE_")
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
  })
  it("does not use old logs to replace a missing selected profile", async () => {
    const ctx = makeCtx(); writeToken(ctx, makeToken({ profileArn: "" })); const assertNoUnboundRead = staleAccountA(ctx)
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kiro usage data unavailable")
    expect(ctx.host.http.request).not.toHaveBeenCalled(); assertNoUnboundRead()
  })
  it("preserves the existing desktop refresh and original-source writeback", async () => {
    const ctx = makeCtx(); writeToken(ctx, makeToken({ accessToken: "", expiresAt: "2026-02-01T00:00:00.000Z" }))
    const original = ctx.host.fs.readText(TOKEN_PATH), writeFixture = ctx.host.fs.writeText
    ctx.host.fs.writeText = vi.fn(() => { throw new Error("Unexpected direct credential write") })
    ctx.host.fs.writeTextIfUnchanged.mockImplementation((path, content, expected) => {
      expect(expected).toBe(ctx.host.crypto.sha256Hex(original))
      if (ctx.host.crypto.sha256Hex(ctx.host.fs.readText(path)) !== expected) return false
      writeFixture(path, content)
      return true
    })
    ctx.host.http.request.mockImplementation((request) => {
      if (request.url.includes("/refreshToken")) {
        expect(JSON.parse(request.bodyText)).toEqual({ refreshToken: "synthetic-refresh-b" })
        return reply({ accessToken: "refreshed-access-token", refreshToken: "refreshed-refresh-token", expiresIn: 3600, profileArn: PROFILE_B })
      }
      expect(request.headers.Authorization).toBe("Bearer refreshed-access-token")
      return reply(usage())
    })
    const result = (await loadPlugin()).probe(ctx)
    expect(line(result, "Credits").used).toBe(60)
    const saved = JSON.parse(ctx.host.fs.readText(TOKEN_PATH))
    expect(saved.accessToken).toBe("refreshed-access-token"); expect(saved.refreshToken).toBe("refreshed-refresh-token")
    expect(ctx.host.fs.writeTextIfUnchanged).toHaveBeenCalledTimes(1)
    expect(ctx.host.fs.writeTextIfUnchanged.mock.calls[0][0]).toBe(TOKEN_PATH)
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
    expect(ctx.host.sqlite.query).not.toHaveBeenCalled()
  })
  it("preserves a new B login when an in-flight A refresh returns", async () => {
    const ctx = makeCtx(); writeToken(ctx, makeToken({ accessToken: "", expiresAt: "2026-02-01T00:00:00.000Z" }))
    const accountB = JSON.stringify(makeToken({ accessToken: "replacement-b", refreshToken: "replacement-refresh-b" }))
    ctx.host.fs.writeText.mockClear()
    ctx.host.http.request.mockImplementation((request) => {
      expect(request.url).toContain("/refreshToken")
      ctx.host.fs.writeText(TOKEN_PATH, accountB)
      return reply({ accessToken: "late-a", refreshToken: "late-refresh-a", expiresIn: 3600 })
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kiro connection changed. Refresh usage.")
    expect(ctx.host.fs.readText(TOKEN_PATH)).toBe(accountB)
    expect(ctx.host.fs.writeText.mock.calls).toEqual([[TOKEN_PATH, accountB]])
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
  })
  it("fails clearly before usage when refreshed credentials cannot be saved", async () => {
    const ctx = makeCtx(); writeToken(ctx, makeToken({ accessToken: "", expiresAt: "2026-02-01T00:00:00.000Z" }))
    const before = ctx.host.fs.readText(TOKEN_PATH)
    ctx.host.http.request.mockReturnValue(reply({ accessToken: "refreshed", expiresIn: 3600 }))
    ctx.host.fs.writeTextIfUnchanged.mockImplementation(() => { throw new Error("PRIVATE_WRITE_ERROR") })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kiro refreshed sign-in could not be saved")
    expect(ctx.host.fs.readText(TOKEN_PATH)).toBe(before)
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("PRIVATE_WRITE_ERROR")
  })
  it("keeps the external IdP headers and selected profile fallback", async () => {
    const ctx = makeCtx(); writeToken(ctx, makeToken({ provider: "ExternalIdp", profileArn: "" }))
    ctx.host.fs.writeText(PROFILE_PATH, JSON.stringify({ arn: PROFILE_B }))
    ctx.host.http.request.mockReturnValue(reply(usage()))
    ;(await loadPlugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers.TokenType).toBe("EXTERNAL_IDP")
    expect(ctx.host.http.request.mock.calls[0][0].url).toContain(encodeURIComponent(PROFILE_B))
  })
  it.each(["bonus", "freeTrial"])("preserves %s at zero main limit without inventing a precise main pool", async (pool) => {
    const ctx = makeCtx(); writeToken(ctx)
    const credit = credits({ currentUsageWithPrecision: 30, usageLimitWithPrecision: 0, bonuses: pool === "bonus" ? [{ currentUsage: 30, usageLimit: 50, expiresAt: "2026-05-03T15:09:55Z" }] : [] })
    if (pool === "freeTrial") credit.freeTrialInfo = { freeTrialStatus: "ACTIVE", currentUsageWithPrecision: 30, usageLimit: 50, freeTrialExpiry: "2026-05-03T15:09:55Z" }
    ctx.host.http.request.mockReturnValue(reply(usage(credit)))
    const result = (await loadPlugin()).probe(ctx)
    expect(line(result, "Credits")).toMatchObject({ type: "badge", text: "Usage unavailable" })
    expect(line(result, "Bonus Credits")).toMatchObject({ used: 30, limit: 50 })
    expect(line(result, "Bonus Credits")).not.toHaveProperty("resetsAt")
    expect(line(result, "Bonus Expiry").value).toBe("2026-05-03T15:09:55.000Z")
  })
})
