import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

describe.each([
  ["zai", () => import("./plugin.js")],
  ["bigmodel-cn", () => import("../bigmodel-cn/plugin.js")],
])("%s quota compatibility", (_providerId, loadPlugin) => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  async function probeQuota(limits, platform = "darwin") {
    const ctx = makeCtx()
    ctx.app.platform = platform
    ctx.host.config.get.mockReturnValue("fixture-key")
    ctx.host.http.request.mockImplementation(({ url }) => ({
      status: 200,
      bodyText: JSON.stringify(url.includes("subscription") ? { data: [] } : { data: { limits } }),
    }))
    await loadPlugin()
    return { result: globalThis.__openusage_plugin.probe(ctx), ctx }
  }

  it.each(["darwin", "windows"])("reads credit quota windows on %s", async (platform) => {
    const { result } = await probeQuota([
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 68 },
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 37 },
      { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 8, usage: 100 },
    ], platform)

    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Session", type: "progress", used: 37, limit: 100, periodDurationMs: 18_000_000 }),
      expect.objectContaining({ label: "Weekly", type: "progress", used: 68, limit: 100, periodDurationMs: 604_800_000 }),
      expect.objectContaining({ label: "Web Searches", type: "progress", used: 8, limit: 100 }),
    ]))
  })

  it.each(["TOKENS_LIMIT", "CREDIT_LIMIT"])("keeps standalone weekly %s and web quotas", async (type) => {
    const { result } = await probeQuota([
      { type, unit: 6, number: 1, percentage: 68 },
      { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 8, usage: 100 },
    ])
    expect(result.lines.map(({ label }) => label)).toEqual(["Weekly", "Web Searches"])
    expect(result.lines[0]).toMatchObject({ type: "progress", used: 68, limit: 100 })
  })

  it("keeps standalone web quota", async () => {
    const { result } = await probeQuota([
      { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 8, usage: 100 },
    ])
    expect(result.lines).toEqual([
      expect.objectContaining({ label: "Web Searches", type: "progress", used: 8, limit: 100 }),
    ])
  })

  it.each([undefined, null, "37", -1])("does not publish invalid session percentage %s as zero", async (percentage) => {
    const { result, ctx } = await probeQuota([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 68 },
    ])
    expect(result.lines).toEqual([
      expect.objectContaining({ label: "Session", type: "badge", text: "Usage unavailable" }),
      expect.objectContaining({ label: "Weekly", type: "progress", used: 68 }),
    ])
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("rejects a percentage that overflows during JSON parsing", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockReturnValue("fixture-key")
    ctx.host.http.request.mockImplementation(({ url }) => ({
      status: 200,
      bodyText: url.includes("subscription") ? '{"data":[]}' :
        '{"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":1e999}]}}',
    }))
    await loadPlugin()
    expect(() => globalThis.__openusage_plugin.probe(ctx)).toThrow("Quota data is incomplete or invalid. Try again later.")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("rejects a response with only invalid quotas", async () => {
    await expect(probeQuota([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: null },
    ])).rejects.toThrow("Quota data is incomplete or invalid. Try again later.")
  })

  it.each([
    { currentValue: undefined, usage: 100 },
    { currentValue: 8, usage: 0 },
    { currentValue: -1, usage: 100 },
    { currentValue: "8", usage: "100" },
    { currentValue: 0.5, usage: 100 },
    { currentValue: 8, usage: Number.MAX_SAFE_INTEGER + 1 },
  ])("does not publish invalid web counters %j as zero", async (values) => {
    const { result, ctx } = await probeQuota([
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
      { type: "TIME_LIMIT", unit: 5, number: 1, ...values },
    ])
    expect(result.lines).toEqual([
      expect.objectContaining({ label: "Session", type: "progress", used: 0 }),
      expect.objectContaining({ label: "Web Searches", type: "badge", text: "Usage unavailable" }),
    ])
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("recognizes a seven-day quota from its actual unit and number", async () => {
    const { result } = await probeQuota([
      { type: "CREDIT_LIMIT", unit: 1, number: 7, percentage: 68 },
    ])
    expect(result.lines).toEqual([
      expect.objectContaining({ label: "Weekly", type: "progress", used: 68, periodDurationMs: 604_800_000 }),
    ])
  })

  it.each([
    { unit: 3, number: 10 },
    { unit: 6, number: 7 },
    { unit: 3 },
    { number: 5 },
    { unit: "3", number: 5 },
    { unit: 3, number: 0 },
  ])("does not relabel an unknown quota window %j as five hours or one week", async (window) => {
    await expect(probeQuota([
      { type: "CREDIT_LIMIT", percentage: 37, ...window },
    ])).rejects.toThrow("Quota data is incomplete or invalid. Try again later.")
  })

  it("does not invent a month boundary or a thirty-day pace window", async () => {
    const { result } = await probeQuota([
      { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 8, usage: 100 },
    ])
    expect(result.lines[0]).not.toHaveProperty("resetsAt")
    expect(result.lines[0]).not.toHaveProperty("periodDurationMs")
  })

  it("uses an explicit monthly reset without guessing its period length", async () => {
    const { result } = await probeQuota([
      { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 8, usage: 100, nextResetTime: 1775020168897 },
    ])
    expect(result.lines[0].resetsAt).toBe("2026-04-01T05:09:28.897Z")
    expect(result.lines[0]).not.toHaveProperty("periodDurationMs")
  })

  it("uses the reported duration for a non-monthly web quota", async () => {
    const { result } = await probeQuota([
      { type: "TIME_LIMIT", unit: 3, number: 5, currentValue: 8, usage: 100 },
    ])
    expect(result.lines[0].periodDurationMs).toBe(18_000_000)
    expect(result.lines[0]).not.toHaveProperty("resetsAt")
  })

  it.each(["2026-10-01T00:00:00Z", -1, 1e20])("omits invalid reset metadata %s without losing valid usage", async (nextResetTime) => {
    const { result, ctx } = await probeQuota([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 37, nextResetTime },
    ])
    expect(result.lines[0]).toMatchObject({ label: "Session", type: "progress", used: 37 })
    expect(result.lines[0]).not.toHaveProperty("resetsAt")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it.each([undefined, null, {}, 42])("rejects malformed limits %j instead of reporting no usage", async (limits) => {
    await expect(probeQuota(limits)).rejects.toThrow("Quota data is incomplete or invalid. Try again later.")
  })

  it.each([
    null,
    { type: "FUTURE_LIMIT", unit: 3, number: 5, percentage: 40 },
    { type: "CREDIT_LIMIT", unit: 6, number: 7, percentage: 40 },
  ])("reports an unsupported bucket %j while preserving a valid sibling", async (unsupported) => {
    const { result, ctx } = await probeQuota([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 37 },
      unsupported,
    ])
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Session", type: "progress", used: 37 }))
    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Quota", type: "badge", text: "Some usage unavailable" }))
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("accepts the existing name alias for a credit quota", async () => {
    const { result } = await probeQuota([
      { name: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 37 },
    ])
    expect(result.lines[0]).toMatchObject({ label: "Session", type: "progress", used: 37 })
  })

  it("reports an explicitly empty list as no usage data", async () => {
    const { result } = await probeQuota([])
    expect(result.lines).toEqual([
      { label: "Session", type: "badge", text: "No usage data", color: "#a3a3a3" },
    ])
  })
})
