import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadPlugin, OAUTH_TOKEN_KEY, OAUTH_TOKEN_SENTINEL, STATE_DB_V2, STATE_DB_V1, LOGIN_MESSAGE, makeDiscovery, makeUserStatusResponse, makeCloudCodeResponse, makeAgyLoadResponse, makeAgyQuotaResponse, setupLsMock, setupSqliteMock, setupSqliteByPath, encodeVarint, encodeField, makeOAuthSentinelB64 } from "./legacy-test-fixtures.js"

describe("antigravity legacy protocol 4", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  it("handles refresh response missing access_token", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.will-fail", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    let oauthCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        oauthCalls += 1
        return { status: 200, bodyText: JSON.stringify({ expires_in: 3600 }) }
      }
      if (url.includes("fetchAvailableModels")) {
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(oauthCalls).toBe(1)
  })

  it("continues to next Cloud Code base URL after non-2xx response", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    let ccCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        ccCalls += 1
        if (ccCalls === 1) return { status: 500, bodyText: "{}" }
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.length).toBeGreaterThan(0)
    expect(ccCalls).toBe(2)
  })

  it("continues to next Cloud Code base URL after a 200 with invalid JSON", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    let ccCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        ccCalls += 1
        if (ccCalls === 1) return { status: 200, bodyText: "{bad json" }
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.length).toBeGreaterThan(0)
    expect(ccCalls).toBe(2)
  })

  it("prefers userTier.name over legacy planInfo.planName for Ultra subscribers", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      userTier: {
        id: "g1-ultra-tier",
        name: "Google AI Ultra",
        description: "Google AI Ultra",
        upgradeSubscriptionText: "You are subscribed to the best plan.",
      },
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Google AI Ultra")
    const labels = result.lines.map((l) => l.label)
    expect(labels).toEqual(["Gemini Pro", "Gemini Flash", "Claude"])
  })

  it("falls back to planInfo.planName when userTier is absent", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()  // no userTier override
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Pro")
  })

  it("falls back to planInfo.planName when userTier.name is empty", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      userTier: { id: "g1-pro-tier", name: "" },
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Pro")
  })

  // --- Regression tests for unified-schema bug fixes ---

  it("refresh-token-only state (no access token, no cache) refreshes and succeeds", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: null, refreshToken: "1//only-refresh", expirySeconds: null }))
    ctx.host.ls.discover.mockReturnValue(null)

    const capturedAuths = []
    let refreshCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        refreshCalls += 1
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.from-refresh", expires_in: 3600 }) }
      }
      if (url.includes("fetchAvailableModels")) {
        capturedAuths.push(opts.headers.Authorization)
        if (opts.headers.Authorization === "Bearer ya29.from-refresh") {
          return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
        }
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(refreshCalls).toBe(1)
    expect(capturedAuths[capturedAuths.length - 1]).toBe("Bearer ya29.from-refresh")
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it("expired access token + valid refresh token: refresh is called exactly once with the refreshed token", async () => {
    const ctx = makeCtx()
    const pastExpiry = Math.floor(Date.now() / 1000) - 60
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.expired", refreshToken: "1//refresh", expirySeconds: pastExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    let refreshCalls = 0
    const ccCallTokens = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        refreshCalls += 1
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.new", expires_in: 3600 }) }
      }
      if (url.includes("fetchAvailableModels")) {
        ccCallTokens.push(opts.headers.Authorization)
        if (opts.headers.Authorization === "Bearer ya29.new") {
          return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
        }
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(refreshCalls).toBe(1)
    // The expired token must never be sent, and Cloud Code is called exactly once with the refreshed token.
    expect(ccCallTokens).toEqual(["Bearer ya29.new"])
  })

  it("DB access token equals cached token: Cloud Code is called exactly once", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.shared", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.shared",
      expiresAtMs: Date.now() + 3600000,
    }))

    let ccCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        ccCalls += 1
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ccCalls).toBe(1)
  })

  it("does not refresh when Cloud Code returns 5xx (transient, not auth)", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.valid", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    let refreshCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        refreshCalls += 1
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.new" }) }
      }
      if (url.includes("fetchAvailableModels")) {
        return { status: 500, bodyText: "" }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(refreshCalls).toBe(0)
  })

  it("does not refresh when Cloud Code calls all throw (timeouts)", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.valid", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.cached",
      expiresAtMs: Date.now() + 3600000,
    }))

    let refreshCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        refreshCalls += 1
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.new" }) }
      }
      if (url.includes("fetchAvailableModels")) {
        throw new Error("timeout")
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(refreshCalls).toBe(0)
  })
})
