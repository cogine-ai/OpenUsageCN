import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

describe("Claude local history isolation", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("returns live quota without invoking a failing local history runner", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-token" } })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ five_hour: { utilization: 35 } }),
    })
    ctx.host.ccusage.query.mockImplementation(() => { throw "local history unavailable" })
    await import("./plugin.js")

    const result = globalThis.__openusage_plugin.probe(ctx)

    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Session", used: 35 }))
    expect(ctx.host.ccusage.query).not.toHaveBeenCalled()
  })

  it("loads history independently without quota HTTP", async () => {
    const ctx = makeCtx()
    ctx.host.ccusage.query.mockReturnValue({ status: "ok", data: { daily: [] } })
    await import("./plugin.js")

    const result = globalThis.__openusage_plugin.probeHistory(ctx)

    expect(result.lines).toContainEqual(expect.objectContaining({ label: "Today" }))
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(ctx.host.ccusage.query).toHaveBeenCalledOnce()
  })

  it("rejects a stale credential lease before starting the local runner", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-token" } })
    await import("./plugin.js")
    expect(() => globalThis.__openusage_plugin.probeHistory(ctx, {
      connectionKey: "claude-oauth", credentialGeneration: "0".repeat(64),
    })).toThrow("credentials changed")
    expect(ctx.host.ccusage.query).not.toHaveBeenCalled()
  })

  it("rejects credentials that change while the history runner is active", async () => {
    const ctx = makeCtx()
    let token = "synthetic-original-token"
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: token } })
    await import("./plugin.js")
    const plugin = globalThis.__openusage_plugin
    const target = { connectionKey: "claude-oauth" }
    target.credentialGeneration = plugin.credentialGeneration(ctx, target)
    ctx.host.ccusage.query.mockImplementation(() => {
      token = "synthetic-replaced-token"
      return { status: "ok", data: { daily: [] } }
    })
    expect(() => plugin.probeHistory(ctx, target)).toThrow("credentials changed")
  })

  it.each([
    [{ status: "no_runner" }, "未找到本地用量工具"],
    [{ status: "runner_failed" }, "暂时无法读取"],
    [{ status: "ok", data: {} }, "暂时无法读取"],
  ])("shows an explicit history error for %j", async (response, message) => {
    const ctx = makeCtx()
    ctx.host.ccusage.query.mockReturnValue(response)
    await import("./plugin.js")
    expect(() => globalThis.__openusage_plugin.probeHistory(ctx)).toThrow(message)
  })

  it("keeps the 31-day query and Today label on one date across midnight", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 7, 23, 59, 59))
    try {
      const ctx = makeCtx()
      ctx.host.ccusage.query.mockImplementation(() => {
        vi.setSystemTime(new Date(2026, 8, 8, 0, 0, 1))
        return { status: "ok", data: { daily: [
          { date: "2026-08-08", totalTokens: 10, totalCost: 1 },
          { date: "2026-09-07", totalTokens: 20, totalCost: 2 },
        ] } }
      })
      await import("./plugin.js")
      const result = globalThis.__openusage_plugin.probeHistory(ctx)
      expect(ctx.host.ccusage.query).toHaveBeenCalledWith({ since: "20260808", until: "20260907" })
      expect(result.lines.find((line) => line.label === "Today")?.value).toContain("20 tokens")
      expect(result.lines.find((line) => line.label === "Last 31 Days")?.value).toContain("30 tokens")
    } finally {
      vi.useRealTimers()
    }
  })
})
