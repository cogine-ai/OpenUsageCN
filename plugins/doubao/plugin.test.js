import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

async function plugin() {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function configured(ctx, region = "cn-beijing") {
  ctx.host.config.get.mockImplementation((name) => ({
    accessKeyId: "fixture-access-id", secretAccessKey: "fixture-secret-key", region,
  })[name] ?? null)
}

function coding(quotas = [{ Level: "session", Percent: 37, ResetTimestamp: 1769994000 }]) {
  return { status: 200, bodyText: JSON.stringify({ Result: { Status: "Active", QuotaUsage: quotas } }) }
}

function agent() {
  return { status: 200, bodyText: JSON.stringify({ Result: {
    AFPFiveHour: { Quota: "100.0", Used: "25.0", ResetTime: 1769994000000 },
    AFPWeekly: { Quota: 200, Used: 100, ResetTime: 1770500000000 },
  } }) }
}

describe("Doubao provider", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("declares actual Coding and Agent Plan quota lines", () => {
    const manifest = JSON.parse(readFileSync("plugins/doubao/plugin.json", "utf8"))
    expect(manifest.id).toBe("doubao")
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["accessKeyId", "secretAccessKey", "region"])
    expect(manifest.lines).toHaveLength(6)
  })

  it("requires AK/SK instead of an inference API key", async () => {
    const ctx = makeCtx()
    const subject = await plugin()
    expect(() => subject.probe(ctx)).toThrow("No Volcengine AK/SK found")
    expect(ctx.host.log.error).toHaveBeenCalledWith(expect.stringContaining("is missing"))
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("logs an invalid region before making a signed request", async () => {
    const ctx = makeCtx()
    configured(ctx, "../wrong")
    const subject = await plugin()
    expect(() => subject.probe(ctx)).toThrow("Invalid Volcengine region")
    expect(ctx.host.log.error).toHaveBeenCalledWith("Doubao Volcengine region is invalid")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("signs the exact Volcengine V4 request and reads both plan products", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) =>
      url.includes("GetAFPUsage") ? agent() : coding())
    const result = (await plugin()).probe(ctx)
    const opts = ctx.host.http.request.mock.calls[0][0]
    expect(opts.url).toBe("https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01")
    expect(opts.method).toBe("POST")
    expect(opts.bodyText).toBe("")
    expect(opts.headers["X-Date"]).toBe("20260202T000000Z")
    expect(opts.headers["X-Content-Sha256"]).toBe(crypto.createHash("sha256").update("").digest("hex"))

    const digest = (value) => crypto.createHash("sha256").update(value).digest("hex")
    const sign = (key, value) => crypto.createHmac("sha256", key).update(value).digest()
    const scope = "20260202/cn-beijing/ark/request"
    const canonicalRequest = [
      "POST", "/", "Action=GetCodingPlanUsage&Version=2024-01-01",
      "content-type:application/x-www-form-urlencoded; charset=utf-8",
      "host:open.volcengineapi.com",
      "x-content-sha256:" + digest(""),
      "x-date:20260202T000000Z", "",
      "content-type;host;x-content-sha256;x-date", digest(""),
    ].join("\n")
    const stringToSign = ["HMAC-SHA256", "20260202T000000Z", scope, digest(canonicalRequest)].join("\n")
    const signingKey = sign(sign(sign(sign("fixture-secret-key", "20260202"), "cn-beijing"), "ark"), "request")
    const signature = sign(signingKey, stringToSign).toString("hex")
    expect(opts.headers.Authorization).toBe(
      "HMAC-SHA256 Credential=fixture-access-id/" + scope +
      ", SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=" + signature)
    expect(result.lines.map((line) => line.label)).toEqual([
      "Coding Plan 5H", "Agent Plan 5H", "Agent Plan Weekly",
    ])
    expect(result.lines.map((line) => line.used)).toEqual([37, 25, 50])
    expect(result.lines[0].resetsAt).toBe("2026-02-02T01:00:00.000Z")
  })

  it("preserves Coding Plan when Agent Plan is unavailable", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) =>
      url.includes("GetAFPUsage") ? { status: 403, bodyText: "{}" } : coding())
    const result = (await plugin()).probe(ctx)
    expect(result.lines).toHaveLength(1)
    expect(ctx.host.log.warn).toHaveBeenCalled()
  })

  it("shows an exhausted Coding Plan quota at 100 percent", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) =>
      url.includes("GetAFPUsage") ? { status: 200, bodyText: '{"Result":{}}' } :
        coding([{ Level: "session", Percent: 125, ResetTimestamp: 1769994000 }]))
    const result = (await plugin()).probe(ctx)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].used).toBe(100)
  })

  it("shows Agent Plan for an account whose Coding Plan response has Status only", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) =>
      url.includes("GetAFPUsage") ? agent() :
        { status: 200, bodyText: '{"Result":{"Status":"Inactive"}}' })
    const result = (await plugin()).probe(ctx)
    expect(result.lines.map((line) => line.label)).toEqual([
      "Agent Plan 5H", "Agent Plan Weekly",
    ])
  })

  it("reports no active plan instead of a false zero reading", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) =>
      url.includes("GetAFPUsage") ? { status: 200, bodyText: '{"Result":{}}' } : coding([]))
    const subject = await plugin()
    expect(() => subject.probe(ctx)).toThrow("No active Doubao Coding Plan or Agent Plan quota")
  })

  it("rejects malformed Agent Plan decimal strings", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockImplementation(({ url }) =>
      url.includes("GetAFPUsage")
        ? { status: 200, bodyText: '{"Result":{"AFPFiveHour":{"Quota":"50.0","Used":"oops"}}}' }
        : coding([]))
    const subject = await plugin()
    expect(() => subject.probe(ctx)).toThrow("Agent Plan response invalid")
    expect(ctx.host.log.warn).toHaveBeenCalled()
  })

  it("fails on malformed quota data and logs the parse failure", async () => {
    const ctx = makeCtx()
    configured(ctx)
    ctx.host.http.request.mockReturnValue(coding([{ Level: "session", Percent: "37" }]))
    const subject = await plugin()
    expect(() => subject.probe(ctx)).toThrow("Doubao Coding Plan response invalid")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })
})
