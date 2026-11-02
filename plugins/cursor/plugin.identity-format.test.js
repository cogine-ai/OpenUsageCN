import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const jwt = (sub, exp = 9999999999) => `a.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.c`

async function setup(subject, responseSubject, refreshedSubject) {
  const ctx = makeCtx()
  ctx.host.keychain.readGenericPassword.mockImplementation(service =>
    service === "cursor-access-token" ? jwt(subject, refreshedSubject ? 1 : 9999999999) : jwt(subject))
  ctx.host.http.request.mockImplementation(request => {
    if (request.url.includes("/oauth/token")) return { status: 200, bodyText: JSON.stringify({ access_token: jwt(refreshedSubject) }) }
    if (request.url.endsWith("/api/auth/me")) return { status: 200, bodyText: JSON.stringify({ sub: responseSubject }) }
    return { status: 200, bodyText: JSON.stringify({ enabled: true, planUsage: { totalSpend: 10, limit: 100 } }) }
  })
  await import("./plugin.js")
  const plugin = globalThis.__openusage_plugin
  const target = { connectionKey: "cursor-cli" }
  target.credentialGeneration = plugin.credentialGeneration(ctx, target)
  return { ctx, plugin, target }
}

beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })

describe("Cursor session identity response formats", () => {
  it.each([
    ["auth0|user-a", "auth0|user-a"],
    ["auth0|user-a", "user-a"],
    ["google-oauth2|user-a", "user-a"],
    ["user-a", "user-a"],
  ])("accepts %s with this session's server subject %s", async (subject, server) => {
    const { ctx, plugin, target } = await setup(subject, server)
    expect(plugin.probe(ctx, target).lines.some(line => line.label === "Total usage")).toBe(true)
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it.each([
    ["auth0|user-a", "google-oauth2|user-a"],
    ["auth0|user-a", "user-b"],
    ["auth0|user-a", "user-a "],
    ["auth0|user-a", " user-a"],
    ["auth0|user-a", null],
    ["auth0|user-a", 7],
    ["auth0|user-a", ""],
    ["auth0|user-a|extra", "user-a"],
    ["|user-a", "user-a"],
    ["auth0|", "user-a"],
    [" auth0|user-a", "user-a"],
    ["auth0|user-a ", "user-a"],
    [" auth0|user-a ", "auth0|user-a"],
  ])("rejects %s with ambiguous or different subject %s", async (subject, server) => {
    const { ctx, plugin, target } = await setup(subject, server)
    expect(() => plugin.probe(ctx, target)).toThrow("identity could not be verified")
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("GetCurrentPeriodUsage"))).toBe(false)
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })

  it.each(["google-oauth2|user-a", "auth0|user-b"])("rejects refreshed identity %s before quota request", async refreshed => {
    const { ctx, plugin, target } = await setup("auth0|user-a", "user-a", refreshed)
    expect(() => plugin.probe(ctx, target)).toThrow("identity could not be verified")
    expect(ctx.host.http.request.mock.calls.some(([r]) => r.url.includes("GetCurrentPeriodUsage"))).toBe(false)
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("keeps two full subjects with the same user component as separate identities", async () => {
    const { ctx, plugin } = await setup("auth0|user-a", "user-a")
    ctx.host.sqlite.query.mockImplementation((_db, sql) => sql.includes("accessToken")
      ? JSON.stringify([{ value: jwt("google-oauth2|user-a") }]) : "[]")
    const report = plugin.discoverConnections(ctx)
    expect(report.observations.map(o => o.normalizedIdentity).sort()).toEqual(["auth0|user-a", "google-oauth2|user-a"])
  })

  it("does not return another provider's refreshed history cookie", async () => {
    const { ctx, plugin, target } = await setup("auth0|user-a", "user-a", "google-oauth2|user-a")
    expect(() => plugin.historyCredential(ctx, target)).toThrow("unavailable for this local session")
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("rejects a changed credential lease even when the new user component is identical", async () => {
    const { ctx, plugin, target } = await setup("auth0|user-a", "user-a")
    ctx.host.keychain.readGenericPassword.mockReturnValue(jwt("google-oauth2|user-a"))
    expect(() => plugin.probe(ctx, target)).toThrow("credentials changed")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
})
