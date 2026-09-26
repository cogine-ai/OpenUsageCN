import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function setEnv(ctx, values) {
  ctx.host.env.get.mockImplementation((name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null
  )
}

describe("openrouter plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("ships metadata with API settings", () => {
    const manifest = JSON.parse(readFileSync("plugins/openrouter/plugin.json", "utf8"))
    expect(manifest.id).toBe("openrouter")
    expect(manifest.name).toBe("OpenRouter")
    expect(manifest.lines.map((line) => line.label)).toEqual([
      "Credits",
      "Balance",
      "Key Limit",
      "Daily Spend",
      "Weekly Spend",
      "Monthly Spend",
    ])
    expect(manifest.lines.find((line) => line.label === "Key Limit").primaryOrder).toBe(1)
    expect(manifest.lines.find((line) => line.label === "Credits").primaryOrder).toBeUndefined()
  })

  it("throws when no API key is configured", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No OpenRouter API key found.")
  })

  it("rejects ambiguous base URLs before sending the API key", async () => {
    const plugin = await loadPlugin()
    const invalidUrls = [
      "https://openrouter.ai@attacker.example/api/v1",
      "https:///api/v1",
      "https://openrouter.ai/api/v1?route=credits",
      "https://openrouter.ai/api/v1?",
      "https://openrouter.ai/api/v1#",
      "https://openrouter.ai\\@attacker.example/api/v1",
      "https://openrouter.ai/api/\u0085v1",
    ]

    for (const apiUrl of invalidUrls) {
      const ctx = makeCtx()
      ctx.host.config.get.mockImplementation((name) => {
        if (name === "apiKey") return "openrouter-api-key"
        if (name === "apiUrl") return apiUrl
        return null
      })
      setEnv(ctx, {})
      ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ data: {} }) })

      expect(() => plugin.probe(ctx)).toThrow("OpenRouter API URL must be a valid HTTPS base URL")
      expect(ctx.host.http.request).not.toHaveBeenCalled()
    }
  })

  it("preserves custom HTTPS base paths and scheme-less compatibility", async () => {
    const plugin = await loadPlugin()
    const cases = [
      {
        apiUrl: " https://Gateway.Example:8443/openrouter/v1/// ",
        expectedBase: "https://gateway.example:8443/openrouter/v1",
      },
      {
        apiUrl: "gateway.example/openrouter/v1/",
        expectedBase: "https://gateway.example/openrouter/v1",
      },
    ]

    for (const { apiUrl, expectedBase } of cases) {
      const ctx = makeCtx()
      ctx.host.config.get.mockImplementation((name) => {
        if (name === "apiKey") return "openrouter-api-key"
        if (name === "apiUrl") return apiUrl
        return null
      })
      setEnv(ctx, {})
      ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ data: {} }) })

      plugin.probe(ctx)

      expect(ctx.host.http.request.mock.calls.map(([opts]) => opts.url)).toEqual([
        expectedBase + "/credits",
        expectedBase + "/key",
      ])
    }
  })

  it("loads credits and key usage", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      OPENROUTER_API_KEY: "openrouter-api-key",
      OPENROUTER_HTTP_REFERER: "https://openusage.example",
      OPENROUTER_X_TITLE: "OpenUsageCN",
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.endsWith("/credits")) {
        return { status: 200, bodyText: JSON.stringify({ data: { total_credits: 100.5, total_usage: 25.75 } }) }
      }
      if (opts.url.endsWith("/key")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: {
              limit: 50,
              usage: 10,
              usage_daily: 1,
              usage_weekly: 2,
              usage_monthly: 3,
              is_free_tier: false,
            },
          }),
        }
      }
      throw new Error("unexpected URL " + opts.url)
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer openrouter-api-key")
    expect(ctx.host.http.request.mock.calls[0][0].headers["HTTP-Referer"]).toBe("https://openusage.example")
    expect(ctx.host.http.request.mock.calls[0][0].headers["X-Title"]).toBe("OpenUsageCN")
    expect(result.lines.find((line) => line.label === "Credits").used).toBe(25.75)
    expect(result.lines.find((line) => line.label === "Credits").limit).toBe(100.5)
    expect(result.lines.find((line) => line.label === "Balance").value).toBe("$74.75")
    expect(result.lines.find((line) => line.label === "Key Limit").used).toBe(10)
    expect(result.lines.find((line) => line.label === "Monthly Spend").value).toBe("$3.00")
  })

  it("keeps key data when credits endpoint is not available", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENROUTER_API_KEY: "openrouter-api-key" })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.endsWith("/credits")) return { status: 403, bodyText: "{}" }
      return { status: 200, bodyText: JSON.stringify({ data: { limit: 25, usage: 5, usage_daily: 1 } }) }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Key Limit").limit).toBe(25)
    expect(result.lines.find((line) => line.label === "Credits")).toBeUndefined()
  })

  it("shows a real zero balance without inventing a credits percentage", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENROUTER_API_KEY: "openrouter-api-key" })
    ctx.host.http.request.mockImplementation((opts) => ({
      status: 200,
      bodyText: JSON.stringify({ data: opts.url.endsWith("/credits")
        ? { total_credits: 0, total_usage: 0 }
        : {} }),
    }))

    const result = (await loadPlugin()).probe(ctx)
    expect(result.lines.find((line) => line.label === "Balance").value).toBe("$0.00")
    expect(result.lines.find((line) => line.label === "Credits")).toBeUndefined()
  })

  it.each(["daily", "weekly", "monthly", null])(
    "uses remaining key quota instead of lifetime spend for a %s limit",
    async (reset) => {
      const ctx = makeCtx()
      setEnv(ctx, { OPENROUTER_API_KEY: "fixture-key" })
      ctx.host.http.request.mockImplementation((opts) => ({
        status: opts.url.endsWith("/credits") ? 403 : 200,
        bodyText: JSON.stringify({ data: {
          limit: 10, limit_remaining: 8, limit_reset: reset,
          usage: 100, usage_daily: 2, usage_weekly: 5, usage_monthly: 9,
        } }),
      }))
      const result = (await loadPlugin()).probe(ctx)
      expect(result.lines.find((line) => line.label === "Key Limit")).toMatchObject({
        used: 2, limit: 10,
      })
    },
  )

  it("keeps exhausted and overdrawn key quotas distinct", async () => {
    const plugin = await loadPlugin()
    for (const [remaining, expectedUsed] of [[0, 10], [-2, 12]]) {
      const ctx = makeCtx()
      setEnv(ctx, { OPENROUTER_API_KEY: "fixture-key" })
      ctx.host.http.request.mockReturnValue({
        status: 200,
        bodyText: JSON.stringify({ data: { limit: 10, limit_remaining: remaining, usage: 100 } }),
      })
      expect(plugin.probe(ctx).lines.find((line) => line.label === "Key Limit").used)
        .toBe(expectedUsed)
    }
  })

  it("does not substitute lifetime spend when a resettable key omits remaining quota", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENROUTER_API_KEY: "fixture-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ data: { limit: 10, limit_reset: "daily", usage: 100 } }),
    })
    await loadPlugin()
    expect(() => globalThis.__openusage_plugin.probe(ctx)).toThrow("Key quota is unavailable")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it.each(["", "not-a-number", 11])("rejects invalid remaining key quota %s", async (remaining) => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENROUTER_API_KEY: "fixture-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ data: { limit: 10, limit_remaining: remaining, usage: 100 } }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Key quota is unavailable")
  })

  it("counts BYOK spend when an all-time key includes it in the limit", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENROUTER_API_KEY: "fixture-key" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ data: {
        limit: 10, usage: 2, byok_usage: 3, include_byok_in_limit: true,
      } }),
    })
    const result = (await loadPlugin()).probe(ctx)
    expect(result.lines.find((line) => line.label === "Key Limit").used).toBe(5)
  })
})
