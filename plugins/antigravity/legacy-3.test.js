import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadPlugin, OAUTH_TOKEN_KEY, OAUTH_TOKEN_SENTINEL, STATE_DB_V2, STATE_DB_V1, LOGIN_MESSAGE, makeDiscovery, makeUserStatusResponse, makeCloudCodeResponse, makeAgyLoadResponse, makeAgyQuotaResponse, setupLsMock, setupSqliteMock, setupSqliteByPath, encodeVarint, encodeField, makeOAuthSentinelB64 } from "./legacy-test-fixtures.js"

describe("antigravity legacy protocol 3", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  it("tries both tokens before refreshing", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.both-fail", refreshToken: "1//refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.cached-also-bad",
      expiresAtMs: Date.now() + 3600000,
    }))

    const capturedTokens = []
    let refreshCalled = false
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        refreshCalled = true
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.refreshed" }) }
      }
      if (url.includes("fetchAvailableModels")) {
        capturedTokens.push(opts.headers.Authorization)
        if (opts.headers.Authorization === "Bearer ya29.refreshed") {
          return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
        }
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(refreshCalled).toBe(true)
    expect(capturedTokens.filter((t) => t === "Bearer ya29.both-fail").length).toBeGreaterThan(0)
    expect(capturedTokens.filter((t) => t === "Bearer ya29.cached-also-bad").length).toBeGreaterThan(0)
    expect(capturedTokens[capturedTokens.length - 1]).toBe("Bearer ya29.refreshed")
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it("deduplicates DB access token and identical cached token", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.same-token", refreshToken: "1//refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.same-token",
      expiresAtMs: Date.now() + 3600000,
    }))

    const capturedTokens = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.refreshed" }) }
      }
      if (url.includes("fetchAvailableModels")) {
        capturedTokens.push(opts.headers.Authorization)
        if (opts.headers.Authorization === "Bearer ya29.same-token") {
          return { status: 401, bodyText: '{"error":"unauthorized"}' }
        }
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const sameTokenCalls = capturedTokens.filter((t) => t === "Bearer ya29.same-token")
    expect(sameTokenCalls.length).toBe(1)
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it("caches refreshed token to pluginDataDir", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.will-fail", refreshToken: "1//refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.refreshed", expires_in: 3599 }) }
      }
      if (url.includes("fetchAvailableModels")) {
        if (opts.headers.Authorization === "Bearer ya29.refreshed") {
          return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
        }
        return { status: 401, bodyText: '{"error":"unauthorized"}' }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    expect(ctx.host.fs.writeText).toHaveBeenCalledWith(cachePath, expect.any(String))
    const cached = JSON.parse(ctx.host.fs.writeText.mock.calls.find((c) => c[0] === cachePath)[1])
    expect(cached.accessToken).toBe("ya29.refreshed")
    expect(cached.expiresAtMs).toBeGreaterThan(Date.now())
  })

  it("uses cached token when no DB access token", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, null)
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.cached-token",
      expiresAtMs: Date.now() + 3600000,
    }))

    const capturedTokens = []
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        capturedTokens.push(opts.headers.Authorization)
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(capturedTokens[0]).toBe("Bearer ya29.cached-token")
  })

  it("throws when cached token is expired and no DB tokens", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, null)
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, JSON.stringify({
      accessToken: "ya29.expired-cache",
      expiresAtMs: Date.now() - 1000,
    }))

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("skips expired DB access token and falls through to refresh", async () => {
    const ctx = makeCtx()
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.expired-proto-token", refreshToken: "1//refresh", expirySeconds: pastExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    const capturedAuths = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("oauth2.googleapis.com")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "ya29.refreshed" }) }
      }
      if (url.includes("fetchAvailableModels")) {
        capturedAuths.push(opts.headers.Authorization)
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    // Expired DB token must NOT be sent. The refreshed token is used instead.
    expect(capturedAuths).not.toContain("Bearer ya29.expired-proto-token")
    expect(capturedAuths[0]).toBe("Bearer ya29.refreshed")
  })

  it("throws when cache file is corrupt and no DB tokens", async () => {
    const ctx = makeCtx()
    setupSqliteMock(ctx, null)
    ctx.host.ls.discover.mockReturnValue(null)

    const cachePath = ctx.app.pluginDataDir + "/auth.json"
    ctx.host.fs.writeText(cachePath, "{bad json")

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("Cloud Code skips models with isInternal flag", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test", refreshToken: "1//r", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            models: {
              "chat_20706": {
                model: "MODEL_CHAT_20706",
                isInternal: true,
                quotaInfo: { remainingFraction: 1, resetTime: "2026-02-08T10:00:00Z" },
              },
              "gemini-3-flash": {
                displayName: "Gemini 3 Flash",
                model: "MODEL_PLACEHOLDER_M18",
                quotaInfo: { remainingFraction: 0.9, resetTime: "2026-02-08T10:00:00Z" },
              },
            },
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const labels = result.lines.map((l) => l.label)
    expect(labels).toContain("Gemini Flash")
    expect(labels).not.toContain("chat_20706")
    expect(labels).not.toContain("MODEL_CHAT_20706")
  })

  it("Cloud Code skips models with empty or missing displayName", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test", refreshToken: "1//r", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            models: {
              "tab_flash_lite": {
                displayName: "",
                model: "SOME_MODEL",
                quotaInfo: { remainingFraction: 1, resetTime: "2026-02-08T10:00:00Z" },
              },
              "no_display_name": {
                model: "ANOTHER_MODEL",
                quotaInfo: { remainingFraction: 1, resetTime: "2026-02-08T10:00:00Z" },
              },
              "gemini-3-pro": {
                displayName: "Gemini 3 Pro",
                model: "MODEL_PLACEHOLDER_M8",
                quotaInfo: { remainingFraction: 0.5, resetTime: "2026-02-08T10:00:00Z" },
              },
            },
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const labels = result.lines.map((l) => l.label)
    expect(labels).toEqual(["Gemini Pro"])
  })

  it("Cloud Code skips blacklisted model IDs", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test", refreshToken: "1//r", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            models: {
              "gemini-2.5-flash": {
                displayName: "Gemini 2.5 Flash",
                model: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
                quotaInfo: { remainingFraction: 1, resetTime: "2026-02-08T10:00:00Z" },
              },
              "gemini-2.5-pro": {
                displayName: "Gemini 2.5 Pro",
                model: "MODEL_GOOGLE_GEMINI_2_5_PRO",
                quotaInfo: { remainingFraction: 0.8, resetTime: "2026-02-08T10:00:00Z" },
              },
              "claude-sonnet-4.5": {
                displayName: "Claude Sonnet 4.5",
                model: "MODEL_CLAUDE_4_5_SONNET",
                quotaInfo: { remainingFraction: 0.6, resetTime: "2026-02-08T10:00:00Z" },
              },
            },
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const labels = result.lines.map((l) => l.label)
    expect(labels).toEqual(["Claude"])
  })

  it("Cloud Code keeps non-blacklisted models with valid displayName", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test", refreshToken: "1//r", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            models: {
              "gemini-3-pro-high": {
                displayName: "Gemini 3 Pro (High)",
                model: "MODEL_PLACEHOLDER_M8",
                quotaInfo: { remainingFraction: 0.7, resetTime: "2026-02-08T10:00:00Z" },
              },
              "claude-opus-4-6-thinking": {
                displayName: "Claude Opus 4.6 (Thinking)",
                model: "MODEL_PLACEHOLDER_M26",
                quotaInfo: { remainingFraction: 1, resetTime: "2026-02-08T10:00:00Z" },
              },
              "gpt-oss-120b": {
                displayName: "GPT-OSS 120B (Medium)",
                model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
                quotaInfo: { remainingFraction: 0.9, resetTime: "2026-02-08T10:00:00Z" },
              },
            },
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const labels = result.lines.map((l) => l.label)
    expect(labels).toEqual(["Gemini Pro", "Claude"])
  })

  it("LS filters out blacklisted model IDs (Claude Opus 4.5)", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        {
          label: "Gemini 3 Pro (High)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M8" },
          quotaInfo: { remainingFraction: 0.75, resetTime: "2026-02-08T09:10:56Z" },
        },
        {
          label: "Claude Opus 4.5 (Thinking)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M12" },
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-02-08T09:10:56Z" },
        },
        {
          label: "Claude Opus 4.6 (Thinking)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M26" },
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-02-08T09:10:56Z" },
        },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const labels = result.lines.map((l) => l.label)
    expect(labels).toEqual(["Gemini Pro", "Claude"])
  })

  it("LS still takes priority over Cloud Code with DB tokens (no regression)", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    const protoB64 = makeOAuthSentinelB64(ctx, { accessToken: "ya29.proto-token", refreshToken: "1//refresh", expirySeconds: futureExpiry })
    setupSqliteMock(ctx, protoB64)
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)
    setupSqliteMock(ctx, protoB64)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // No userTier in default fixture → falls back to planInfo.planName
    expect(result.plan).toBe("Pro")
    const calls = ctx.host.http.request.mock.calls.map((c) => String(c[0].url))
    expect(calls.filter((u) => u.includes("fetchAvailableModels")).length).toBe(0)
    expect(calls.filter((u) => u.includes("oauth2.googleapis.com")).length).toBe(0)
  })

  it("throws when Cloud Code returns no models", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        return { status: 200, bodyText: JSON.stringify({}) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })


})
