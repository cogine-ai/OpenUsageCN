import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const BALANCE_URL = "https://api.deepseek.com/user/balance"

async function loadPlugin() {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function setCredentials(ctx, configured, fromEnv) {
  ctx.host.config.get.mockImplementation((key) => key === "apiKey" ? configured : null)
  ctx.host.env.get.mockImplementation((key) => key === "DEEPSEEK_API_KEY" ? fromEnv : null)
}

function setResponse(ctx, data, status = 200) {
  ctx.host.http.request.mockReturnValue({ status, bodyText: JSON.stringify(data) })
}

describe("deepseek plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("declares the balance lines and a themeable icon", () => {
    const manifest = JSON.parse(readFileSync("plugins/deepseek/plugin.json", "utf8"))
    const icon = readFileSync("plugins/deepseek/icon.svg", "utf8")
    expect(manifest).toMatchObject({ id: "deepseek", name: "DeepSeek", brandColor: "#5786FE" })
    expect(manifest.lines.map((line) => line.label)).toEqual([
      "API Access", "CNY Balance", "USD Balance", "CNY Granted",
      "CNY Topped Up", "USD Granted", "USD Topped Up",
    ])
    expect(icon).toContain('fill="currentColor"')
  })

  it("requires a key and reads only the DeepSeek environment fallback", async () => {
    const ctx = makeCtx()
    setCredentials(ctx, null, null)
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("No DeepSeek API key found")
    expect(ctx.host.env.get).toHaveBeenCalledWith("DEEPSEEK_API_KEY")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(ctx.host.log.error).toHaveBeenCalledWith("DeepSeek API key is not configured")
  })

  it("prefers the Settings key and requests the fixed balance endpoint", async () => {
    const ctx = makeCtx()
    setCredentials(ctx, "  settings-key  ", "environment-key")
    setResponse(ctx, { is_available: false, balance_infos: [] })
    const plugin = await loadPlugin()

    plugin.probe(ctx)

    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.http.request).toHaveBeenCalledWith({
      method: "GET",
      url: BALANCE_URL,
      headers: {
        Authorization: "Bearer settings-key",
        Accept: "application/json",
      },
      timeoutMs: 15000,
    })
  })

  it("uses DEEPSEEK_API_KEY when no Settings key exists", async () => {
    const ctx = makeCtx()
    setCredentials(ctx, null, "  environment-key  ")
    setResponse(ctx, { is_available: false, balance_infos: [] })
    const plugin = await loadPlugin()

    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer environment-key")
  })

  it("keeps CNY and USD balances separate, including paid and granted portions", async () => {
    const ctx = makeCtx()
    setCredentials(ctx, "fixture-key", null)
    setResponse(ctx, {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        { currency: "USD", total_balance: "2.50", granted_balance: "0.50", topped_up_balance: "2.00" },
      ],
    })
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines).toEqual([
      { type: "badge", label: "API Access", text: "Available", color: "#16a34a" },
      { type: "text", label: "CNY Balance", value: "¥110.00" },
      { type: "text", label: "CNY Granted", value: "¥10.00" },
      { type: "text", label: "CNY Topped Up", value: "¥100.00" },
      { type: "text", label: "USD Balance", value: "$2.50" },
      { type: "text", label: "USD Granted", value: "$0.50" },
      { type: "text", label: "USD Topped Up", value: "$2.00" },
    ])
  })

  it("shows unavailable without inventing a balance when DeepSeek returns no entries", async () => {
    const ctx = makeCtx()
    setCredentials(ctx, "fixture-key", null)
    setResponse(ctx, { is_available: false, balance_infos: [] })
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines).toEqual([
      { type: "badge", label: "API Access", text: "Unavailable", color: "#ef4444" },
    ])
  })

  it("reports an invalid key and logs only the status, not the credential", async () => {
    const ctx = makeCtx()
    setCredentials(ctx, "fixture-secret-key", null)
    setResponse(ctx, {}, 401)
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API key invalid")
    expect(ctx.host.log.error).toHaveBeenCalledWith("DeepSeek balance request rejected the API key (HTTP 401)")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("fixture-secret-key")
  })

  it("logs HTTP, network, and invalid-response failures with friendly errors", async () => {
    const plugin = await loadPlugin()
    const scenarios = [
      {
        response: { status: 503, bodyText: "unavailable" },
        message: "Balance request failed (HTTP 503)",
      },
      {
        exception: new Error("socket closed"),
        message: "Balance request failed. Check your connection.",
      },
      {
        response: { status: 200, bodyText: "not json" },
        message: "Balance response invalid.",
      },
      {
        response: { status: 200, bodyText: JSON.stringify({ is_available: true, balance_infos: [] }) },
        message: "Balance response invalid.",
      },
    ]
    for (const scenario of scenarios) {
      const ctx = makeCtx()
      setCredentials(ctx, "fixture-key", null)
      if (scenario.exception) ctx.host.http.request.mockImplementation(() => { throw scenario.exception })
      else ctx.host.http.request.mockReturnValue(scenario.response)
      expect(() => plugin.probe(ctx)).toThrow(scenario.message)
      expect(ctx.host.log.error).toHaveBeenCalled()
    }
  })

  it("rejects missing or malformed amounts instead of displaying zero", async () => {
    const plugin = await loadPlugin()
    for (const balance of ["", "NaN", "1e500", null]) {
      const ctx = makeCtx()
      setCredentials(ctx, "fixture-key", null)
      setResponse(ctx, {
        is_available: true,
        balance_infos: [{
          currency: "CNY", total_balance: balance,
          granted_balance: "0.00", topped_up_balance: "1.00",
        }],
      })
      expect(() => plugin.probe(ctx)).toThrow("Balance response invalid")
      expect(ctx.host.log.error).toHaveBeenCalled()
    }
  })
})
