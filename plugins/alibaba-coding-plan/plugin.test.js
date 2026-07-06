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

const QUOTA = {
  successResponse: {
    codingPlanQuotaInfo: {
      per5HourUsedQuota: 25,
      per5HourTotalQuota: 100,
      per5HourQuotaNextRefreshTime: "2026-02-02T05:00:00Z",
      perWeekUsedQuota: 50,
      perWeekTotalQuota: 200,
      perBillMonthUsedQuota: 100,
      perBillMonthTotalQuota: 400,
    },
    planName: "coding plan public",
  },
}

describe("alibaba-coding-plan plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("ships separate provider metadata", () => {
    const manifest = JSON.parse(readFileSync("plugins/alibaba-coding-plan/plugin.json", "utf8"))
    expect(manifest.id).toBe("alibaba-coding-plan")
    expect(manifest.name).toBe("Alibaba Coding Plan")
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["source", "region", "apiKey", "cookieHeader"])
    expect(manifest.lines.map((line) => line.label)).toEqual(["Session", "Weekly", "Monthly"])
  })

  it("throws when no API key or cookie is available", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No Alibaba Coding Plan API key found.")
  })

  it("uses API key endpoint in auto mode", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { ALIBABA_CODING_PLAN_API_KEY: "public-alibaba-key" })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(QUOTA) })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]

    expect(call.url).toContain("modelstudio.console.alibabacloud.com/data/api.json")
    expect(call.headers.Authorization).toBe("Bearer public-alibaba-key")
    expect(call.headers["X-DashScope-API-Key"]).toBe("public-alibaba-key")
    expect(call.bodyText).toContain("sfm_codingplan_public_intl")
    expect(result.plan).toBe("Coding Plan Public")
    expect(result.lines.find((line) => line.label === "Session").used).toBe(25)
    expect(result.lines.find((line) => line.label === "Weekly").used).toBe(25)
    expect(result.lines.find((line) => line.label === "Monthly").used).toBe(25)
  })

  it("uses China region commodity code when configured", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockImplementation((key) => {
      if (key === "region") return "cn"
      return null
    })
    setEnv(ctx, { DASHSCOPE_API_KEY: "public-dashscope-key" })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(QUOTA) })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const call = ctx.host.http.request.mock.calls[0][0]
    expect(call.url).toContain("bailian.console.aliyun.com/data/api.json")
    expect(call.url).toContain("currentRegionId=cn-beijing")
    expect(call.bodyText).toContain("sfm_codingplan_public_cn")
  })

  it("throws when manual cookie source is configured without a cookie", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockImplementation((key) => (key === "source" ? "manual-cookie" : null))
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "No Alibaba Coding Plan cookie found. Add it in Settings or set ALIBABA_CODING_PLAN_COOKIE."
    )
  })

  it("throws when cookie is missing sec_token", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockImplementation((key) => {
      if (key === "source") return "manual-cookie"
      if (key === "cookieHeader") return "login_aliyunid_ticket=ticket; csrf=csrf-header-value"
      return null
    })
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "Alibaba Coding Plan cookie missing sec_token. Copy a fresh console Cookie header."
    )
  })

  it("throws when API key auth fails", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { ALIBABA_CODING_PLAN_API_KEY: "public-alibaba-key" })
    ctx.host.http.request.mockReturnValue({ status: 401, bodyText: "{}" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Alibaba Coding Plan API key invalid. Check your API key.")
  })

  it("throws when cookie auth fails", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockImplementation((key) => {
      if (key === "source") return "manual-cookie"
      if (key === "cookieHeader") return "login_aliyunid_ticket=ticket; sec_token=console-session-value; csrf=csrf-header-value"
      return null
    })
    setEnv(ctx, {})
    ctx.host.http.request.mockReturnValue({ status: 403, bodyText: "{}" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "Alibaba Coding Plan login expired. Copy a fresh console Cookie header."
    )
  })

  it("uses manual cookie source without importing browser cookies", async () => {
    const ctx = makeCtx()
    ctx.host.config.get.mockImplementation((key) => {
      if (key === "source") return "manual-cookie"
      if (key === "cookieHeader") return "login_aliyunid_ticket=ticket; sec_token=console-session-value; csrf=csrf-header-value"
      return null
    })
    setEnv(ctx, {})
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(QUOTA) })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]

    expect(call.url).toContain("bailian-singapore-cs.alibabacloud.com/data/api.json")
    expect(call.headers.Cookie).toContain("sec_token=console-session-value")
    expect(call.headers["x-csrf-token"]).toBe("csrf-header-value")
    expect(call.bodyText).toContain("sec_token=console-session-value")
    expect(result.lines[0].label).toBe("Session")
  })
})
