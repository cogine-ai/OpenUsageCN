import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const RESET_URL = "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL"
const record = (recordId, expireTime, extra = {}) => ({ recordId, expireTime, available: true, grantType: "GLOBAL", ...extra })
const list = () => ({ success: true, data: {
  fiveHourResets: [record(12, "2026-11-10 08:00:00"), record(11, "2026-11-06 20:00:00"),
    record(13, "2026-11-07 08:00:00", { available: false }), record(14, "2026-11-04 08:00:00")],
  weekResets: [record(21, "2026-11-06 20:00:00")],
} })
const line = (output, label) => output.lines.find((row) => row.label === label)
async function setup(resetResponse = { status: 200, bodyText: JSON.stringify(list()) }) {
  await import("./resets.js")
  await import("./plugin.js")
  const ctx = makeCtx()
  ctx.nowIso = "2026-11-04T00:00:00.000Z"
  ctx.host.config.get.mockImplementation((name) => name === "apiKey" ? "synthetic-saved-account-a" : null)
  ctx.host.env.get.mockReturnValue("synthetic-other-account-b")
  ctx.host.http.request.mockImplementation((request) => {
    expect(request.method).toBe("GET")
    expect(request.headers.Authorization).toBe("Bearer synthetic-saved-account-a")
    if (request.url === RESET_URL) return typeof resetResponse === "function" ? resetResponse(request) : resetResponse
    return { status: 200, bodyText: JSON.stringify(request.url.includes("subscription")
      ? { data: [{ productName: "GLM Coding Pro" }] }
      : { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 64 }] } }) }
  })
  return { ctx, probe: () => globalThis.__openusage_plugin.probe(ctx) }
}
afterEach(() => { vi.restoreAllMocks() })
beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin; delete globalThis.__openusage_zai_resets })

describe("Z.ai read-only reset coupons", () => {
  it("keeps each window separate and uses the earliest unexpired UTC+8 date without merging equal expiries", async () => {
    const { ctx, probe } = await setup()
    const output = probe()
    expect(line(output, "5h Reset Coupons").value).toBe("2")
    expect(line(output, "Weekly Reset Coupons").value).toBe("1")
    expect(line(output, "Coupon Expiry")).toMatchObject({ value: "2026-11-06 20:00", subtitle: "UTC+08:00" })
    expect(ctx.host.http.request.mock.calls.at(-1)[0]).toMatchObject({ url: RESET_URL, timeoutMs: 5000 })
    expect(ctx.host.http.request.mock.calls.every(([request]) => request.method === "GET" && !request.url.includes("/use"))).toBe(true)
    expect(JSON.stringify(output)).not.toContain("recordId")
    expect(JSON.stringify(output)).not.toContain("grantType")
    expect(line(output, "Session")).toMatchObject({ used: 64, limit: 100 })
    expect(line(output, "Coupon Expiry")).not.toHaveProperty("resetsAt")
  })
  it("preserves explicit zero separately from unavailable lists", async () => {
    const { probe } = await setup({ status: 200, bodyText: JSON.stringify({ data: { fiveHourResets: [], weekResets: [] } }) })
    const output = probe()
    expect(line(output, "5h Reset Coupons").value).toBe("0")
    expect(line(output, "Weekly Reset Coupons").value).toBe("0")
    expect(line(output, "Coupon Expiry").value).toBe("None")
  })
  it("does not interpret an absent window as zero or guess the overall earliest expiry", async () => {
    const { probe } = await setup({ status: 200, bodyText: JSON.stringify({ data: { fiveHourResets: [record(1, "2026-11-07 00:30:00")] } }) })
    const output = probe()
    expect(line(output, "5h Reset Coupons").value).toBe("1")
    expect(line(output, "Weekly Reset Coupons").value).toBe("Unavailable")
    expect(line(output, "Coupon Expiry").value).toBe("Unavailable")
  })
  it.each([401, 403, 429, 503])("retains primary quota after optional reset HTTP %i without changing credential source", async (status) => {
    const { ctx, probe } = await setup({ status, bodyText: "private response" })
    const output = probe()
    expect(line(output, "Session").used).toBe(64)
    expect(line(output, "5h Reset Coupons").value).toBe("Unavailable")
    expect(ctx.host.log.warn).toHaveBeenCalledWith("Z.ai reset coupons could not be read; quota remains available")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(3)
  })
  it.each(["not json", JSON.stringify({ success: false, data: {} }), JSON.stringify({ data: null })])("keeps quota after malformed reset responses", async (bodyText) => {
    const { probe } = await setup({ status: 200, bodyText })
    expect(line(probe(), "Session").used).toBe(64)
  })
  it("logs a fixed message on optional network errors, never the thrown private error", async () => {
    const { ctx, probe } = await setup(() => { throw new Error("synthetic-secret-api-key") })
    expect(line(probe(), "Session").used).toBe(64)
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("synthetic-secret-api-key")
  })
  it.each([
    { expireTime: "2026-02-30 08:00:00" }, { expireTime: "2026-11-06T20:00:00Z" },
    { recordId: 1.1 }, { recordId: "1" }, { grantType: "" }, { grantType: undefined },
  ])("marks only the malformed window unavailable: %j", async (invalid) => {
    const response = list()
    response.data.fiveHourResets = [record(1, "2026-11-07 00:30:00", invalid)]
    const { probe } = await setup({ status: 200, bodyText: JSON.stringify(response) })
    const output = probe()
    expect(line(output, "5h Reset Coupons").value).toBe("Unavailable")
    expect(line(output, "Weekly Reset Coupons").value).toBe("1")
    expect(line(output, "Session").used).toBe(64)
  })
  it("handles UTC+8 crossing midnight and excludes an expiry equal to now", async () => {
    const response = { data: { fiveHourResets: [record(1, "2026-11-04 08:00:00"), record(2, "2026-11-05 00:30:00")], weekResets: [] } }
    const { probe } = await setup({ status: 200, bodyText: JSON.stringify(response) })
    expect(line(probe(), "Coupon Expiry")).toMatchObject({ value: "2026-11-05 00:30", subtitle: "UTC+08:00" })
  })
  it("skips an optional request when prior work used its 25-second local budget", async () => {
    let now = 0
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const { ctx, probe } = await setup()
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => {
      const response = original(request)
      if (request.url.includes("/quota/")) now = 25000
      return response
    })
    const output = probe()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
    expect(line(output, "Session").used).toBe(64)
    expect(line(output, "5h Reset Coupons").value).toBe("Unavailable")
  })
  it("clamps the optional request to the remaining local budget", async () => {
    let now = 0
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const { ctx, probe } = await setup()
    const original = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => {
      const response = original(request)
      if (request.url.includes("/quota/")) now = 23000
      return response
    })
    expect(line(probe(), "Session").used).toBe(64)
    expect(ctx.host.http.request.mock.calls.at(-1)[0].timeoutMs).toBe(2000)
  })

})
