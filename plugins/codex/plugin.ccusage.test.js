import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

// Relative local day key so fixtures stay inside the rolling trend window.
function dayKey(daysAgo) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return year + "-" + month + "-" + day
}

describe("codex plugin ccusage usage trend", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("adds model percentage text lines and a usage chart from codex ccusage", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText("~/.codex/auth.json", JSON.stringify({
      tokens: { access_token: "token" },
      last_refresh: new Date().toISOString(),
    }))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: { "x-codex-primary-used-percent": "10" },
      bodyText: JSON.stringify({}),
    })
    ctx.host.ccusage.query.mockReturnValue({
      status: "ok",
      data: {
        daily: [
          {
            date: dayKey(0),
            totalTokens: 300,
            models: {
              "gpt-5.5": { totalTokens: 200 },
              "gpt-5": { totalTokens: 100 },
            },
          },
          {
            date: dayKey(1),
            totalTokens: 150,
            models: {
              "gpt-5": { inputTokens: 30, cachedInputTokens: 20, outputTokens: 50 },
            },
          },
        ],
      },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const chart = result.lines.find((line) => line.label === "用量趋势")
    expect(chart).toMatchObject({
      type: "barChart",
      note: "根据所选账号的本地 Codex 日志估算。",
    })
    expect(chart.points.map((point) => point.value)).toEqual([150, 300])

    const gpt55 = result.lines.find((line) => line.label === "gpt-5.5")
    const gpt5 = result.lines.find((line) => line.label === "gpt-5")
    expect(gpt55).toMatchObject({
      type: "text",
      value: "50%",
    })
    expect(gpt5).toMatchObject({
      type: "text",
      value: "50%",
    })
  })

  it("formats token counts with Chinese ten-thousand and hundred-million units", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText("~/.codex/auth.json", JSON.stringify({
      tokens: { access_token: "token" },
      last_refresh: new Date().toISOString(),
    }))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: { "x-codex-primary-used-percent": "10" },
      bodyText: JSON.stringify({}),
    })
    ctx.host.ccusage.query.mockReturnValue({
      status: "ok",
      data: {
        daily: [
          { date: dayKey(3), totalTokens: 9999 },
          { date: dayKey(2), totalTokens: 10000 },
          { date: dayKey(1), totalTokens: 6005000 },
          { date: dayKey(0), totalTokens: 10000000 },
        ],
      },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const chart = result.lines.find((line) => line.label === "用量趋势")
    expect(chart.points.map((point) => point.valueLabel)).toEqual([
      "9999.0 tokens",
      "1.0万 tokens",
      "600.5万 tokens",
      "0.1亿 tokens",
    ])
  })
})
