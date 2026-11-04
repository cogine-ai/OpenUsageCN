import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadPlugin, OAUTH_TOKEN_KEY, OAUTH_TOKEN_SENTINEL, STATE_DB_V2, STATE_DB_V1, LOGIN_MESSAGE, makeDiscovery, makeUserStatusResponse, makeCloudCodeResponse, makeAgyLoadResponse, makeAgyQuotaResponse, setupLsMock, setupSqliteMock, setupSqliteByPath, encodeVarint, encodeField, makeOAuthSentinelB64 } from "./legacy-test-fixtures.js"

describe("antigravity legacy protocol 2", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  it("falls back to legacy SQLite credentials when the new path has no usable token", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteByPath(ctx, {
      [STATE_DB_V2]: "not-valid-protobuf!!!",
      [STATE_DB_V1]: makeOAuthSentinelB64(ctx, { accessToken: "ya29.v1-token", refreshToken: "1//v1", expirySeconds: futureExpiry }),
    })
    ctx.host.ls.discover.mockReturnValue(null)

    let capturedAuth = null
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        capturedAuth = opts.headers.Authorization
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(capturedAuth).toBe("Bearer ya29.v1-token")
  })

  it("uses the agy keychain account when no local server or SQLite credentials work", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, null)
    ctx.host.ls.discover.mockReturnValue(null)
    ctx.host.keychain.readGenericPassword.mockImplementation((service, account) => {
      if (service === "gemini" && account === "antigravity") {
        return "go-keyring-base64:" + ctx.base64.encode(JSON.stringify({
          tokens: { access_token: "agy-keychain-token" },
        }))
      }
      throw new Error("unexpected keychain lookup")
    })

    const called = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      called.push({ url, auth: opts.headers.Authorization, userAgent: opts.headers["User-Agent"], body: opts.bodyText })
      if (url.includes("loadCodeAssist")) {
        return { status: 200, bodyText: JSON.stringify(makeAgyLoadResponse()) }
      }
      if (url.includes("retrieveUserQuota")) {
        return { status: 200, bodyText: JSON.stringify(makeAgyQuotaResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(ctx.host.keychain.readGenericPassword).toHaveBeenCalledWith("gemini", "antigravity")
    expect(called.every((call) => call.auth === "Bearer agy-keychain-token")).toBe(true)
    expect(called.every((call) => call.userAgent === "agy")).toBe(true)
    expect(called.map((call) => call.url)).toEqual([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ])
    expect(result.plan).toBe("Google AI Pro")
    expect(result.lines.map((l) => l.label)).toEqual(["Gemini Pro", "Gemini Flash", "Claude"])
  })

  it("tries agy Cloud Code even when the keychain token matches a SQLite token", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "same-token", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)
    ctx.host.keychain.readGenericPassword.mockImplementation((service, account) => {
      if (service === "gemini" && account === "antigravity") {
        return "go-keyring-base64:" + ctx.base64.encode(JSON.stringify({
          tokens: { access_token: "same-token" },
        }))
      }
      return null
    })

    let agyCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) return { status: 500, bodyText: "" }
      if (url.includes("loadCodeAssist")) {
        agyCalls += 1
        return { status: 200, bodyText: JSON.stringify(makeAgyLoadResponse()) }
      }
      if (url.includes("retrieveUserQuota")) {
        agyCalls += 1
        return { status: 200, bodyText: JSON.stringify(makeAgyQuotaResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Google AI Pro")
    expect(agyCalls).toBe(2)
  })

  it("Cloud Code sends correct Authorization header with DB token", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.proto-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    let capturedHeaders = null
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) {
        capturedHeaders = opts.headers
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(capturedHeaders).toBeTruthy()
    expect(capturedHeaders.Authorization).toBe("Bearer ya29.proto-token")
    expect(capturedHeaders["User-Agent"]).toBe("antigravity")
  })

  it("Cloud Code returns null on 401/403 (invalid token, no refresh)", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.bad-token", refreshToken: null, expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) {
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })

  it("Cloud Code tries multiple base URLs", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    const calledUrls = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) {
        calledUrls.push(url)
        if (url.includes("daily-cloudcode")) {
          throw new Error("network error")
        }
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(calledUrls.length).toBe(2)
    expect(calledUrls[0]).toContain("daily-cloudcode-pa.googleapis.com")
    expect(calledUrls[1]).toContain("cloudcode-pa.googleapis.com")
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it("Cloud Code correctly parses model quota response", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            models: {
              "gemini-3-pro-high": {
                displayName: "Gemini 3 Pro (High)",
                quotaInfo: { remainingFraction: 0.7, resetTime: "2026-02-08T12:00:00Z" },
              },
              "gemini-3-pro-low": {
                displayName: "Gemini 3 Pro (Low)",
                quotaInfo: { remainingFraction: 0.9, resetTime: "2026-02-08T12:00:00Z" },
              },
            },
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const pro = result.lines.find((l) => l.label === "Gemini Pro")
    expect(pro).toBeTruthy()
    expect(pro.used).toBe(30)
  })

  it("skips Cloud Code when no credentials available", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(null)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("LS takes priority over Cloud Code when both available", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // No userTier in default fixture → falls back to planInfo.planName
    expect(result.plan).toBe("Pro")
    const calls = ctx.host.http.request.mock.calls.map((c) => String(c[0].url))
    const ccCalls = calls.filter((u) => u.includes("fetchAvailableModels"))
    expect(ccCalls.length).toBe(0)
  })

  it("Cloud Code omits models without quotaInfo", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            models: {
              "valid-model": {
                displayName: "Gemini 3 Pro",
                quotaInfo: { remainingFraction: 0.5, resetTime: "2026-02-08T12:00:00Z" },
              },
              "no-quota": {
                displayName: "Gemini Flash (No Quota)",
              },
            },
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const noQuota = result.lines.find((l) => l.label === "Gemini Flash")
    expect(noQuota).toBeUndefined()
    expect(result.lines.find((l) => l.label === "Gemini Pro")).toBeTruthy()
  })

  it("decodes protobuf tokens from SQLite", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-access", refreshToken: "1//refresh-token", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    let capturedAuth = null
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) {
        capturedAuth = opts.headers.Authorization
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(capturedAuth).toBe("Bearer ya29.test-access")
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it("throws when unified oauth envelope is missing and no cache", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, null)
    ctx.host.ls.discover.mockReturnValue(null)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("throws when unified oauth envelope is corrupt and no cache", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, "not-valid-protobuf!!!")
    ctx.host.ls.discover.mockReturnValue(null)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("handles protobuf with no refresh_token or expiry", async () => {
    const ctx = makeCtx()
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.access-only", refreshToken: null, expirySeconds: null })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    let capturedAuth = null
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        capturedAuth = opts.headers.Authorization
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(capturedAuth).toBe("Bearer ya29.access-only")
  })

  it("sends correct form-urlencoded POST to Google OAuth", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.expired", refreshToken: "1//my-refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    let oauthBody = null
    let oauthHeaders = null
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        oauthBody = opts.bodyText
        oauthHeaders = opts.headers
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.refreshed-token" }) }
      }
      if (url.includes("fetchAvailableModels")) {
        if (opts.headers.Authorization === "Bearer ya29.refreshed-token") {
          return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
        }
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(oauthHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded")
    expect(oauthBody).toContain("client_id=")
    expect(oauthBody).toContain("client_secret=")
    expect(oauthBody).toContain("refresh_token=" + encodeURIComponent("1//my-refresh"))
    expect(oauthBody).toContain("grant_type=refresh_token")
  })

  it("throws when all tokens fail and refresh returns invalid_grant", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.expired", refreshToken: "1//bad-refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        return { status: 400, bodyText: '{"error":"invalid_grant"}' }
      }
      if (url.includes("fetchAvailableModels")) {
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })

  it("tries DB token first, then cached on auth failure", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.proto-first", refreshToken: "1//refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.cached",
      expiresAtMs: Date.now() + 3600000,
    }))

    const capturedTokens = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) {
        capturedTokens.push(opts.headers.Authorization)
        if (opts.headers.Authorization === "Bearer ya29.proto-first") {
          return { status: 401, bodyText: '{"error":"unauthorized"}' }
        }
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(capturedTokens[0]).toBe("Bearer ya29.proto-first")
    expect(capturedTokens[capturedTokens.length - 1]).toBe("Bearer ya29.cached")
    expect(result.lines.length).toBeGreaterThan(0)
  })


})
