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

describe("opencode plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("ships web subscription metadata", () => {
    const manifest = JSON.parse(readFileSync("plugins/opencode/plugin.json", "utf8"))
    expect(manifest.id).toBe("opencode")
    expect(manifest.name).toBe("OpenCode")
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["cookieHeader", "workspaceId"])
    expect(manifest.lines.map((line) => line.label)).toEqual(["Session", "Weekly", "Renews"])
  })

  it("throws when cookie is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No OpenCode cookie found.")
  })

  it("uses configured workspace ID directly", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      OPENCODE_COOKIE: "__Host-auth=public-cookie",
      OPENCODE_WORKSPACE_ID: "https://opencode.ai/workspace/wrk_PUBLIC123/billing",
    })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        data: {
          rollingUsage: { usagePercent: 17, resetInSec: 600 },
          weeklyUsage: { usagePercent: 75, resetInSec: 3600 },
          renewAt: "2026-03-01T00:00:00Z",
        },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]

    expect(call.url).toContain("7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4")
    expect(call.url).toContain(encodeURIComponent('["wrk_PUBLIC123"]'))
    expect(call.headers.Cookie).toBe("__Host-auth=public-cookie")
    expect(result.lines.find((line) => line.label === "Session").used).toBe(17)
    expect(result.lines.find((line) => line.label === "Weekly").used).toBe(75)
    expect(result.lines.find((line) => line.label === "Renews").value).toBe("2026-03-01")
  })

  it("discovers workspace ID when not configured", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENCODE_COOKIE: "__Host-auth=public-cookie" })
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.url.includes("def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f")) {
        return { status: 200, bodyText: ';id:"wrk_DISCOVERED123",name:"Default"' }
      }
      return {
        status: 200,
        bodyText: "$R[16]($R[30],$R[41]={rollingUsage:$R[42]={status:\"ok\",resetInSec:5944,usagePercent:17},weeklyUsage:$R[43]={status:\"ok\",resetInSec:278201,usagePercent:75}});",
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[1][0].url).toContain(encodeURIComponent('["wrk_DISCOVERED123"]'))
    expect(result.lines.find((line) => line.label === "Session").used).toBe(17)
  })

  it("rejects signed out responses", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { OPENCODE_COOKIE: "__Host-auth=public-cookie", OPENCODE_WORKSPACE_ID: "wrk_PUBLIC123" })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: "please sign in" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenCode session expired.")
  })
})
