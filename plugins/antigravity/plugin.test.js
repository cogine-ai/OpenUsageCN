import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadPlugin, OAUTH_TOKEN_KEY, OAUTH_TOKEN_SENTINEL, STATE_DB_V2, STATE_DB_V1, LOGIN_MESSAGE, makeDiscovery, makeUserStatusResponse, makeCloudCodeResponse, makeAgyLoadResponse, makeAgyQuotaResponse, setupLsMock, setupSqliteMock, setupSqliteByPath, encodeVarint, encodeField, makeOAuthSentinelB64 } from "./legacy-test-fixtures.js"

describe("antigravity legacy protocol 1", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })
  it("throws when LS not found and no DB credentials", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(null)
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })

  it("throws when no working port found and no DB credentials", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(makeDiscovery())
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("connection refused")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })

  it("throws when both GetUserStatus and GetCommandModelConfigs fail", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(makeDiscovery())
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetUnleashData")) {
        return { status: 200, bodyText: "{}" }
      }
      return { status: 500, bodyText: "" }
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })

  it("discovers new Antigravity process names and agy fallback", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(null)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)

    expect(ctx.host.ls.discover).toHaveBeenNthCalledWith(1, expect.objectContaining({
      processName: "language_server",
      markers: ["antigravity", "antigravity-ide"],
      csrfFlag: "--csrf_token",
    }))
    expect(ctx.host.ls.discover).toHaveBeenNthCalledWith(2, expect.objectContaining({
      processName: "agy",
      markers: [],
      csrfFlag: "",
    }))
  })

  it("returns models from the agy local server when Antigravity is not running", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockImplementation((opts) => {
      if (opts.processName === "agy") return makeDiscovery({ csrf: "", ports: [43001] })
      return null
    })

    let capturedCsrf = null
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetUnleashData")) {
        capturedCsrf = opts.headers["x-codeium-csrf-token"]
        return { status: 200, bodyText: "{}" }
      }
      if (url.includes("GetUserStatus")) {
        return {
          status: 200,
          bodyText: JSON.stringify(makeUserStatusResponse({
            userTier: { name: "Google AI Pro" },
          })),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(capturedCsrf).toBe("")
    expect(result.plan).toBe("Google AI Pro")
    expect(result.lines.map((l) => l.label)).toEqual(["Gemini Pro", "Gemini Flash", "Claude"])
  })

  it("returns models + plan from GetUserStatus", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // No userTier in default fixture → falls back to planInfo.planName
    expect(result.plan).toBe("Pro")

    // Model lines exist — 3 pool lines
    const labels = result.lines.map((l) => l.label)
    expect(labels).toEqual(["Gemini Pro", "Gemini Flash", "Claude"])
  })

  it("deduplicates models by normalized label (keeps worst-case fraction)", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // Both Gemini 3.1 Pro variants have frac=0.8 → used = 20%
    const pro = result.lines.find((l) => l.label === "Gemini Pro")
    expect(pro).toBeTruthy()
    expect(pro.used).toBe(20) // (1 - 0.8) * 100
  })

  it("orders: Gemini (Pro, Flash), Claude (Opus, Sonnet), then others", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const labels = result.lines.map((l) => l.label)

    expect(labels).toEqual(["Gemini Pro", "Gemini Flash", "Claude"])
  })

  it("falls back to GetCommandModelConfigs when GetUserStatus fails", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(makeDiscovery())
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetUnleashData")) {
        return { status: 200, bodyText: "{}" }
      }
      if (String(opts.url).includes("GetUserStatus")) {
        return { status: 500, bodyText: "" }
      }
      if (String(opts.url).includes("GetCommandModelConfigs")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            clientModelConfigs: [
              {
                label: "Gemini 3 Pro (High)",
                modelOrAlias: { model: "M7" },
                quotaInfo: { remainingFraction: 0.6, resetTime: "2026-02-08T09:10:56Z" },
              },
            ],
          }),
        }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()

    // Model lines present
    const pro = result.lines.find((l) => l.label === "Gemini Pro")
    expect(pro).toBeTruthy()
    expect(pro.used).toBe(40) // (1 - 0.6) * 100
  })

  it("uses extension port as fallback when all ports fail probing", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(makeDiscovery({ ports: [99999], extensionPort: 42010 }))

    let usedPort = null
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetUnleashData") && url.includes("99999")) {
        throw new Error("refused")
      }
      if (url.includes("GetUserStatus")) {
        usedPort = parseInt(url.match(/:(\d+)\//)[1])
        return {
          status: 200,
          bodyText: JSON.stringify(makeUserStatusResponse()),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(usedPort).toBe(42010)
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it("omits models with no quotaInfo", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        { label: "Gemini 3 Pro (High)", modelOrAlias: { model: "M7" }, quotaInfo: { remainingFraction: 0.5, resetTime: "2026-02-08T09:10:56Z" } },
        { label: "Claude Opus 4.6 (Thinking)", modelOrAlias: { model: "M26" } },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const claude = result.lines.find((l) => l.label === "Claude")
    expect(claude).toBeUndefined()
    expect(result.lines.find((l) => l.label === "Gemini Pro")).toBeTruthy()
  })

  it("missing quota does not override a valid sibling", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        { label: "Gemini 3 Pro (High)", modelOrAlias: { model: "M7" }, quotaInfo: { remainingFraction: 0.75, resetTime: "2026-02-08T09:10:56Z" } },
        { label: "Gemini 3 Pro (Low)", modelOrAlias: { model: "M8" } },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const pro = result.lines.find((l) => l.label === "Gemini Pro")
    expect(pro).toBeTruthy()
    expect(pro.used).toBe(25)
    expect(pro.resetsAt).toBe("2026-02-08T09:10:56Z")
  })

  it("reports unavailable when no model has quota information", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        { label: "Gemini 3 Pro (High)", modelOrAlias: { model: "M7" } },
        { label: "Claude Opus 4.6 (Thinking)", modelOrAlias: { model: "M26" } },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(LOGIN_MESSAGE)
  })

  it("skips configs with missing or empty labels", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        { label: "Gemini 3 Pro (High)", modelOrAlias: { model: "M7" }, quotaInfo: { remainingFraction: 0.5, resetTime: "2026-02-08T09:10:56Z" } },
        { label: "", modelOrAlias: { model: "M99" }, quotaInfo: { remainingFraction: 0.8, resetTime: "2026-02-08T09:10:56Z" } },
        { modelOrAlias: { model: "M100" }, quotaInfo: { remainingFraction: 0.9, resetTime: "2026-02-08T09:10:56Z" } },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.length).toBe(1)
    expect(result.lines[0].label).toBe("Gemini Pro")
  })

  it("includes resetsAt on model lines", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const pro = result.lines.find((l) => l.label === "Gemini Pro")
    expect(pro.resetsAt).toBe("2026-02-08T09:10:56Z")
  })

  it("clamps remainingFraction outside 0-1 range", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        { label: "Gemini Pro (Over)", modelOrAlias: { model: "M1" }, quotaInfo: { remainingFraction: 1.5, resetTime: "2026-02-08T09:10:56Z" } },
        { label: "Gemini Flash (Neg)", modelOrAlias: { model: "M2" }, quotaInfo: { remainingFraction: -0.3, resetTime: "2026-02-08T09:10:56Z" } },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const over = result.lines.find((l) => l.label === "Gemini Pro")
    const neg = result.lines.find((l) => l.label === "Gemini Flash")
    expect(over.used).toBe(0) // clamped to 1.0 → 0% used
    expect(neg.used).toBe(100) // clamped to 0.0 → 100% used
  })

  it("handles missing resetTime gracefully", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse({
      configs: [
        { label: "Gemini Pro (No Reset)", modelOrAlias: { model: "M1" }, quotaInfo: { remainingFraction: 0.5 } },
      ],
    })
    setupLsMock(ctx, discovery, response)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const line = result.lines.find((l) => l.label === "Gemini Pro")
    expect(line).toBeTruthy()
    expect(line.used).toBe(50)
    expect(line.resetsAt).toBeUndefined()
  })

  it("probes ports with HTTPS first, then HTTP, picks first success", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(makeDiscovery({ ports: [10001, 10002] }))

    const probed = []
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetUnleashData")) {
        const port = parseInt(url.match(/:(\d+)\//)[1])
        const scheme = url.startsWith("https") ? "https" : "http"
        probed.push({ port, scheme })
        // Port 10001 refuses both, port 10002 accepts HTTPS
        if (port === 10002 && scheme === "https") return { status: 200, bodyText: "{}" }
        throw new Error("refused")
      }
      return { status: 200, bodyText: JSON.stringify(makeUserStatusResponse()) }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)
    // Should try HTTPS then HTTP on 10001 (both fail), then HTTPS on 10002 (success)
    expect(probed).toEqual([
      { port: 10001, scheme: "https" },
      { port: 10001, scheme: "http" },
      { port: 10002, scheme: "https" },
    ])
  })

  it("never sends apiKey in LS metadata (unified schema has no apiKey)", async () => {
    const ctx = makeCtx()
    const discovery = makeDiscovery()
    const response = makeUserStatusResponse()
    setupLsMock(ctx, discovery, response)

    let capturedMetadata = null
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetUnleashData")) {
        return { status: 200, bodyText: "{}" }
      }
      if (url.includes("GetUserStatus")) {
        const body = JSON.parse(opts.bodyText)
        capturedMetadata = body.metadata
        return { status: 200, bodyText: JSON.stringify(response) }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.length).toBeGreaterThan(0)
    expect(capturedMetadata).toBeTruthy()
    expect(capturedMetadata.apiKey).toBeUndefined()
  })

  it("falls back to Cloud Code API when LS is not available", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteMock(ctx, makeOAuthSentinelB64(ctx, { accessToken: "ya29.test-token", refreshToken: "1//refresh", expirySeconds: futureExpiry }))
    ctx.host.ls.discover.mockReturnValue(null)

    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("fetchAvailableModels")) {
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()
    const labels = result.lines.map((l) => l.label)
    expect(labels).toContain("Gemini Pro")
    expect(labels).toContain("Claude")
  })

  it("tries Antigravity IDE SQLite credentials before legacy Antigravity credentials", async () => {
    const ctx = makeCtx()
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600
    setupSqliteByPath(ctx, {
      [STATE_DB_V2]: makeOAuthSentinelB64(ctx, { accessToken: "ya29.v2-token", refreshToken: "1//v2", expirySeconds: futureExpiry }),
      [STATE_DB_V1]: makeOAuthSentinelB64(ctx, { accessToken: "ya29.v1-token", refreshToken: "1//v1", expirySeconds: futureExpiry }),
    })
    ctx.host.ls.discover.mockReturnValue(null)

    const capturedAuths = []
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("fetchAvailableModels")) {
        capturedAuths.push(opts.headers.Authorization)
        return { status: 200, bodyText: JSON.stringify(makeCloudCodeResponse()) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.sqlite.query.mock.calls.map((call) => call[0])).toEqual([STATE_DB_V2, STATE_DB_V1])
    expect(capturedAuths[0]).toBe("Bearer ya29.v2-token")
  })


})
