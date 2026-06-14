import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"

const QUOTA_RESPONSE = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    planName: "GLM Coding Pro",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 25,
        nextResetTime: 1775020168897,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 9,
        nextResetTime: 1775588029998,
      },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 224,
        remaining: 3776,
        percentage: 5,
        usageDetails: [
          { modelCode: "search-prime", usage: 210 },
          { modelCode: "web-reader", usage: 14 },
        ],
      },
    ],
  },
}

const mockEnv = (ctx, values) => {
  ctx.host.env.get.mockImplementation((name) => values[name] ?? null)
}

const mockQuota = (ctx, payload = QUOTA_RESPONSE, status = 200) => {
  ctx.host.http.request.mockReturnValue({ status, bodyText: JSON.stringify(payload) })
}

describe("bigmodel-cn plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when no BigModel API key env vars are set and does not read Z.ai env vars", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, {
      ZAI_API_KEY: "must-not-use",
      GLM_API_KEY: "must-not-use",
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No BIGMODEL_API_KEY found. Set up environment variable first.")
    expect(ctx.host.env.get).toHaveBeenCalledWith("BIGMODEL_API_KEY")
    expect(ctx.host.env.get).toHaveBeenCalledWith("ZHIPUAI_API_KEY")
    expect(ctx.host.env.get).not.toHaveBeenCalledWith("ZAI_API_KEY")
    expect(ctx.host.env.get).not.toHaveBeenCalledWith("GLM_API_KEY")
  })

  it("prefers BIGMODEL_API_KEY over ZHIPUAI_API_KEY", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, {
      BIGMODEL_API_KEY: "bigmodel-key",
      ZHIPUAI_API_KEY: "zhipu-key",
    })
    mockQuota(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer bigmodel-key")
  })

  it("falls back to ZHIPUAI_API_KEY when BIGMODEL_API_KEY is missing", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { ZHIPUAI_API_KEY: "zhipu-key" })
    mockQuota(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer zhipu-key")
  })

  it("requests the BigModel CN quota URL with a Bearer API key", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    mockQuota(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledWith({
      method: "GET",
      url: QUOTA_URL,
      headers: {
        Authorization: "Bearer test-key",
        Accept: "application/json",
      },
      timeoutMs: 10000,
    })
  })

  it("renders Session, Weekly, and Web Searches from BigModel quota limits", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    mockQuota(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("GLM Coding Pro")

    const session = result.lines.find((line) => line.label === "Session")
    expect(session).toMatchObject({
      type: "progress",
      used: 25,
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: 5 * 60 * 60 * 1000,
      resetsAt: new Date(1775020168897).toISOString(),
    })

    const weekly = result.lines.find((line) => line.label === "Weekly")
    expect(weekly).toMatchObject({
      type: "progress",
      used: 9,
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: 7 * 24 * 60 * 60 * 1000,
      resetsAt: new Date(1775588029998).toISOString(),
    })

    const web = result.lines.find((line) => line.label === "Web Searches")
    const expected1st = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1))
    expect(web).toMatchObject({
      type: "progress",
      used: 224,
      limit: 4000,
      format: { kind: "count", suffix: "/ 4000" },
      periodDurationMs: 30 * 24 * 60 * 60 * 1000,
      resetsAt: expected1st.toISOString(),
    })
  })

  it("extracts plan from fallback plan fields without failing when missing", async () => {
    const fields = ["plan", "plan_type", "packageName"]

    for (const field of fields) {
      delete globalThis.__openusage_plugin
      vi.resetModules()
      const ctx = makeCtx()
      mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
      mockQuota(ctx, {
        data: {
          [field]: "Fallback Plan",
          limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }],
        },
      })

      const plugin = await loadPlugin()
      expect(plugin.probe(ctx).plan).toBe("Fallback Plan")
    }

    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    mockQuota(ctx, { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }] } })

    const plugin = await loadPlugin()
    expect(plugin.probe(ctx).plan).toBeNull()
  })

  it("throws on 401 and 403 auth responses", async () => {
    for (const status of [401, 403]) {
      delete globalThis.__openusage_plugin
      vi.resetModules()
      const ctx = makeCtx()
      mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
      mockQuota(ctx, {}, status)

      const plugin = await loadPlugin()
      expect(() => plugin.probe(ctx)).toThrow("API key invalid. Check your BigModel CN API key.")
    }
  })

  it("throws on non-auth HTTP errors", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    mockQuota(ctx, {}, 500)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed (HTTP 500). Try again later.")
  })

  it("throws on network exception", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("ECONNRESET")
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed. Check your connection.")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("throws on invalid JSON", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage response invalid. Try again later.")
  })

  it("shows a no usage badge when limits are empty", async () => {
    const ctx = makeCtx()
    mockEnv(ctx, { BIGMODEL_API_KEY: "test-key" })
    mockQuota(ctx, { data: { limits: [] } })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toEqual([
      { type: "badge", label: "Session", text: "No usage data", color: "#a3a3a3" },
    ])
  })
})
