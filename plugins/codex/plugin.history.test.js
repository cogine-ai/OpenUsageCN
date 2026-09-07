import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

describe("Codex local history isolation", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("returns live quota without invoking a failing local history runner", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText("~/.codex/auth.json", JSON.stringify({
      tokens: { access_token: "synthetic-token" },
      last_refresh: new Date().toISOString(),
    }))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: { "x-codex-primary-used-percent": "35" },
      bodyText: "{}",
    })
    ctx.host.ccusage.query.mockImplementation(() => { throw "local history unavailable" })
    await import("./plugin.js")

    const result = globalThis.__openusage_plugin.probe(ctx)

    expect(result.lines).toContainEqual(expect.objectContaining({ label: "5小时", used: 35 }))
    expect(ctx.host.ccusage.query).not.toHaveBeenCalled()
  })

  it("loads history independently without quota HTTP or credentials", async () => {
    const ctx = makeCtx()
    ctx.host.ccusage.query.mockReturnValue({ status: "ok", data: { daily: [] } })
    await import("./plugin.js")

    const result = globalThis.__openusage_plugin.probeHistory(ctx)

    expect(result.lines).toContainEqual(expect.objectContaining({ label: "今日" }))
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(ctx.host.ccusage.query).toHaveBeenCalledOnce()
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
          { date: "2026-08-08", totalTokens: 10, costUSD: 1 },
          { date: "2026-09-07", totalTokens: 20, costUSD: 2 },
        ] } }
      })
      await import("./plugin.js")
      const result = globalThis.__openusage_plugin.probeHistory(ctx)
      expect(ctx.host.ccusage.query).toHaveBeenCalledWith({ provider: "codex", since: "20260808", until: "20260907" })
      expect(result.lines.find((line) => line.label === "今日")?.value).toContain("20.0 tokens")
      expect(result.lines.find((line) => line.label === "近31天")?.value).toContain("30.0 tokens")
    } finally {
      vi.useRealTimers()
    }
  })
})
