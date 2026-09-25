import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

async function plugin() {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function configured(ctx, key = "management-key", team = "team-123") {
  ctx.host.config.get.mockImplementation((name) =>
    name === "managementKey" ? key : name === "teamId" ? team : null)
}

describe("xAI provider", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("declares a distinct Management API credential", () => {
    const manifest = JSON.parse(readFileSync("plugins/xai/plugin.json", "utf8"))
    expect(manifest.id).toBe("xai")
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["managementKey", "teamId"])
    expect(manifest.lines.map((line) => line.label)).toEqual(["Prepaid Balance", "30D Spend", "Daily Spend"])
  })

  it("rejects missing or unsafe team IDs before sending the key", async () => {
    const subject = await plugin()
    for (const team of [null, "../outside", "a/b", "team?x=1"]) {
      const ctx = makeCtx()
      configured(ctx, "management-key", team)
      expect(() => subject.probe(ctx)).toThrow("Missing or invalid xAI Team ID.")
      expect(ctx.host.log.error).toHaveBeenCalledWith("xAI Team ID is missing or invalid")
      expect(ctx.host.http.request).not.toHaveBeenCalled()
    }
  })

  it("rejects inference-only or missing management credentials", async () => {
    const subject = await plugin()
    const missing = makeCtx()
    expect(() => subject.probe(missing)).toThrow("No xAI Management API key")
    expect(missing.host.log.error).toHaveBeenCalledWith("xAI Management API key is missing")
    const invalid = makeCtx()
    configured(invalid)
    invalid.host.http.request.mockReturnValue({ status: 403, bodyText: "{}" })
    expect(() => subject.probe(invalid)).toThrow("Inference keys cannot read billing")
  })

  it("reads signed cents balance and 30-day daily spend", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) => ({
      status: 200,
      bodyText: JSON.stringify(url.endsWith("/prepaid/balance")
        ? { total: { val: "-12345" } }
        : { timeSeries: [{ dataPoints: [
          { timestamp: "2026-02-01T12:00:00Z", values: [1.2] },
          { timestamp: "2026-02-01T23:00:00Z", values: [0.8] },
          { timestamp: "2026-02-02T00:00:00Z", values: [2] },
        ] }] }),
    }))
    const result = (await plugin()).probe(ctx)
    expect(ctx.host.http.request.mock.calls.map(([opts]) => opts.url)).toEqual([
      "https://management-api.x.ai/v1/billing/teams/team-123/prepaid/balance",
      "https://management-api.x.ai/v1/billing/teams/team-123/usage",
    ])
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer management-key")
    expect(JSON.parse(ctx.host.http.request.mock.calls[1][0].bodyText).analyticsRequest.timeUnit).toBe("TIME_UNIT_DAY")
    expect(result.lines[0].value).toBe("$123.45")
    expect(result.lines[1].value).toBe("$4.00")
    expect(result.lines[2].points).toEqual([
      { label: "2026-02-01", value: 2 }, { label: "2026-02-02", value: 2 },
    ])
  })

  it("keeps balance and logs when optional history is unavailable", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) => ({
      status: url.endsWith("/usage") ? 503 : 200,
      bodyText: JSON.stringify({ total: { val: "-250" } }),
    }))
    const result = (await plugin()).probe(ctx)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].value).toBe("$2.50")
    expect(ctx.host.log.warn).toHaveBeenCalled()
  })

  it("does not hide authentication failure on the history request", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) => ({
      status: url.endsWith("/usage") ? 401 : 200,
      bodyText: JSON.stringify({ total: { val: "-250" } }),
    }))
    const subject = await plugin()
    expect(() => subject.probe(ctx)).toThrow("Management API key invalid")
  })

  it("labels a truncated analytics result as partial", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) => ({
      status: 200,
      bodyText: JSON.stringify(url.endsWith("/usage")
        ? { timeSeries: [], limitReached: true }
        : { total: { val: "0" } }),
    }))
    const result = (await plugin()).probe(ctx)
    expect(result.lines[1].subtitle).toBe("Partial history")
    expect(result.lines[2].note).toBe("Partial history")
  })
})
