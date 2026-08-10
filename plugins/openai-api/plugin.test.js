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

describe("openai-api plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("ships metadata with admin settings", () => {
    const manifest = JSON.parse(readFileSync("plugins/openai-api/plugin.json", "utf8"))
    expect(manifest.id).toBe("openai-api")
    expect(manifest.name).toBe("OpenAI API")
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["apiKey", "projectId"])
    expect(manifest.lines.map((line) => line.label)).toEqual(["7D Spend", "Requests", "Tokens", "Credits"])
  })

  it("throws when no key is configured", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No OpenAI API key found.")
  })

  it("uses admin usage and cost endpoints", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENAI_ADMIN_KEY: "admin-api-key", OPENAI_PROJECT_ID: "proj_public_test" })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("/organization/costs")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: [{ results: [{ amount: { value: 12.34, currency: "usd" } }] }],
          }),
        }
      }
      if (opts.url.includes("/organization/usage/completions")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: [{ results: [{ num_model_requests: 42, input_tokens: 1000, input_cached_tokens: 200, output_tokens: 500 }] }],
          }),
        }
      }
      throw new Error("unexpected URL " + opts.url)
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Admin API Project")
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer admin-api-key")
    expect(ctx.host.http.request.mock.calls[0][0].url).toContain("project_ids=proj_public_test")
    expect(result.lines.find((line) => line.label === "7D Spend").value).toBe("$12.34")
    expect(result.lines.find((line) => line.label === "Requests").value).toBe("42")
    expect(result.lines.find((line) => line.label === "Tokens").value).toBe("1.5K")
    expect(result.lines.find((line) => line.label === "Cached Tokens").value).toBe("200")
  })

  it("falls back to legacy credits when admin auth is rejected", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENAI_API_KEY: "standard-api-key" })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("/organization/")) return { status: 403, bodyText: "{}" }
      if (opts.url.includes("/dashboard/billing/credit_grants")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ total_granted: 100, total_used: 25, total_available: 75 }),
        }
      }
      throw new Error("unexpected URL " + opts.url)
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const credits = result.lines.find((line) => line.label === "Credits")

    expect(result.plan).toBe("Legacy API Key")
    expect(credits.used).toBe(25)
    expect(credits.limit).toBe(100)
    expect(credits.format).toEqual({ kind: "dollars" })
    expect(result.lines.find((line) => line.label === "Balance").value).toBe("$75.00")
  })

  it("throws a project-specific error when admin auth fails with a project id", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENAI_ADMIN_KEY: "admin-api-key", OPENAI_PROJECT_ID: "proj_public_test" })
    ctx.host.http.request.mockImplementation(() => ({ status: 403, bodyText: "{}" }))

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "OpenAI Admin API key invalid or lacks organization usage access."
    )
  })

  it("prefers configured apiKey and projectId over environment variables", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockImplementation((key) => {
      if (key === "apiKey") return "configured-admin-key"
      if (key === "projectId") return "configured-project"
      return null
    })
    setEnv(ctx, { OPENAI_ADMIN_KEY: "env-admin-key", OPENAI_PROJECT_ID: "env-project" })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("/organization/costs")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: [{ results: [{ amount: { value: 1, currency: "usd" } }] }],
          }),
        }
      }
      if (opts.url.includes("/organization/usage/completions")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: [{ results: [{ num_model_requests: 1, input_tokens: 0, output_tokens: 0 }] }],
          }),
        }
      }
      throw new Error("unexpected URL " + opts.url)
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const firstRequest = ctx.host.http.request.mock.calls[0][0]
    expect(firstRequest.headers.Authorization).toBe("Bearer configured-admin-key")
    expect(firstRequest.url).toContain("project_ids=configured-project")
  })

  it("formats compact counts and non-USD spend", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENAI_ADMIN_KEY: "admin-api-key" })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("/organization/costs")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: [{ results: [{ amount: { value: 9.5, currency: "eur" } }] }],
          }),
        }
      }
      if (opts.url.includes("/organization/usage/completions")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: [
              {
                results: [
                  {
                    num_model_requests: 1500,
                    input_tokens: 2500,
                    input_cached_tokens: 0,
                    output_tokens: 1_500_000,
                  },
                ],
              },
            ],
          }),
        }
      }
      throw new Error("unexpected URL " + opts.url)
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "7D Spend").value).toBe("EUR 9.50")
    expect(result.lines.find((line) => line.label === "Requests").value).toBe("1.5K")
    expect(result.lines.find((line) => line.label === "Tokens").value).toBe("1.5M")
  })
})
