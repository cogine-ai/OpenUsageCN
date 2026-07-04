import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function writeGeminiFiles(ctx, creds, settings = { selectedAuthType: "oauth-personal" }) {
  ctx.host.fs.writeText("~/.gemini/settings.json", JSON.stringify(settings))
  ctx.host.fs.writeText("~/.gemini/oauth_creds.json", JSON.stringify(creds))
}

describe("gemini plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("ships Gemini CLI metadata", () => {
    const manifest = JSON.parse(readFileSync("plugins/gemini/plugin.json", "utf8"))
    expect(manifest.id).toBe("gemini")
    expect(manifest.name).toBe("Gemini")
    expect(manifest.config.fields[0].id).toBe("configDir")
    expect(manifest.lines.map((line) => line.label)).toEqual(["Pro", "Flash", "Flash Lite"])
  })

  it("throws when Gemini OAuth credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Gemini OAuth credentials not found.")
  })

  it("rejects API key auth settings", async () => {
    const ctx = makeCtx()
    writeGeminiFiles(ctx, { access_token: "oauth-access-token" }, { selectedAuthType: "api-key" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("auth is not supported")
  })

  it("reads quota using Gemini CLI OAuth token", async () => {
    const ctx = makeCtx()
    writeGeminiFiles(ctx, {
      access_token: "oauth-access-token",
      expiry_date: Date.parse("2026-02-02T01:00:00.000Z"),
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("loadCodeAssist")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            cloudaicompanionProject: { projectId: "public-gemini-project" },
            currentTier: { id: "standard-tier" },
          }),
        }
      }
      if (opts.url.includes("retrieveUserQuota")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            buckets: [
              { modelId: "model-pro", remainingFraction: 0.25, resetTime: "2026-02-03T00:00:00Z" },
              { modelId: "model-flash", remainingFraction: 0.8, resetTime: "2026-02-03T00:00:00Z" },
              { modelId: "model-flash-lite", remainingFraction: 0.95, resetTime: "2026-02-03T00:00:00Z" },
            ],
          }),
        }
      }
      throw new Error("unexpected URL " + opts.url)
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Paid")
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer oauth-access-token")
    expect(ctx.host.http.request.mock.calls[1][0].bodyText).toContain("public-gemini-project")
    expect(result.lines.find((line) => line.label === "Pro").used).toBe(75)
    expect(result.lines.find((line) => line.label === "Flash").used).toBe(20)
    expect(result.lines.find((line) => line.label === "Flash Lite").used).toBe(5)
  })

  it("refreshes an expired token when client credentials are present", async () => {
    const ctx = makeCtx()
    writeGeminiFiles(ctx, {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      client_id: "public-client-id",
      client_secret: "public-client-secret",
      expiry_date: Date.parse("2026-02-01T00:00:00.000Z"),
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("oauth2.googleapis.com/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "fresh-token" }) }
      }
      if (opts.url.includes("loadCodeAssist")) return { status: 200, bodyText: JSON.stringify({ currentTier: { id: "free-tier" } }) }
      return { status: 200, bodyText: JSON.stringify({ buckets: [{ modelId: "model-pro", remainingFraction: 0.5 }] }) }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].bodyText).toContain("grant_type=refresh_token")
    expect(ctx.host.http.request.mock.calls[1][0].headers.Authorization).toBe("Bearer fresh-token")
    expect(result.plan).toBe("Free")
  })
})
