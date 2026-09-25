import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function setConfig(ctx, values) {
  ctx.host.config.get.mockImplementation((name) => values[name] ?? null)
}

function setEnv(ctx, values) {
  ctx.host.env.get.mockImplementation((name) => values[name] ?? null)
}

function response(data = {}) {
  return {
    status: 200,
    bodyText: JSON.stringify({
      code: 0,
      scode: "0x0",
      status: true,
      data: {
        available_balance: 49.58,
        cash_balance: -0.42,
        voucher_balance: 50,
        ...data,
      },
    }),
  }
}

describe("moonshot plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("declares separate regional API key fields and a themed icon", () => {
    const manifest = JSON.parse(readFileSync("plugins/moonshot/plugin.json", "utf8"))
    const icon = readFileSync("plugins/moonshot/icon.svg", "utf8")
    expect(manifest.id).toBe("moonshot")
    expect(manifest.brandColor).toBe("#007CFF")
    expect(manifest.config.fields.map((field) => field.id)).toEqual([
      "region", "apiKeyIntl", "apiKeyCn",
    ])
    expect(icon).toContain("currentColor")
  })

  it.each([
    ["international", "apiKeyIntl", "https://api.moonshot.ai/v1/users/me/balance", "$"],
    ["china", "apiKeyCn", "https://api.moonshot.cn/v1/users/me/balance", "CN¥"],
  ])("reads the %s regional balance", async (region, keyField, endpoint, currency) => {
    const ctx = makeCtx()
    setConfig(ctx, { region, [keyField]: "regional-key" })
    ctx.host.http.request.mockReturnValue(response())

    const result = (await loadPlugin()).probe(ctx)
    expect(ctx.host.http.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: endpoint,
      headers: { Authorization: "Bearer regional-key", Accept: "application/json" },
    }))
    expect(result.lines).toMatchObject([
      { label: "Available Balance", value: currency + "49.58" },
      { label: "Cash Balance", value: "-" + currency + "0.42" },
      { label: "Voucher Balance", value: currency + "50.00" },
    ])
  })

  it("never sends a key from the other region", async () => {
    const ctx = makeCtx()
    setConfig(ctx, { region: "china", apiKeyIntl: "international-key" })
    setEnv(ctx, { MOONSHOT_API_KEY: "environment-key", MOONSHOT_REGION: "international" })
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("No Moonshot API key for this region")
    expect(ctx.host.log.error).toHaveBeenCalledWith("Moonshot API key for selected region is missing")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("uses the environment key only for its declared region", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { MOONSHOT_API_KEY: "china-key", MOONSHOT_REGION: "china" })
    ctx.host.http.request.mockReturnValue(response())

    ;(await loadPlugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0]).toMatchObject({
      url: "https://api.moonshot.cn/v1/users/me/balance",
      headers: { Authorization: "Bearer china-key" },
    })
  })

  it("surfaces rejected keys and logs the HTTP status", async () => {
    const ctx = makeCtx()
    setConfig(ctx, { apiKeyIntl: "bad-key" })
    ctx.host.http.request.mockReturnValue({ status: 401, bodyText: "{}" })
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Moonshot API key was rejected")
    expect(ctx.host.log.error).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"))
  })

  it("rejects incomplete balance data instead of showing a false zero", async () => {
    const ctx = makeCtx()
    setConfig(ctx, { apiKeyIntl: "regional-key" })
    ctx.host.http.request.mockReturnValue(response({ available_balance: null }))
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Moonshot balance response is invalid")
    expect(ctx.host.log.error).toHaveBeenCalledWith(expect.stringContaining("available_balance"))
  })

  it("reports a network failure without logging the key", async () => {
    const ctx = makeCtx()
    setConfig(ctx, { apiKeyIntl: "sensitive-regional-key" })
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("request failed with sensitive-regional-key")
    })
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Moonshot balance request failed. Check your connection.")
    expect(ctx.host.log.error).toHaveBeenCalledWith("Moonshot balance request failed before receiving a response")
  })
})
