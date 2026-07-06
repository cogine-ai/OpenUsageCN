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

describe("alibaba-token-plan plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("ships separate token plan metadata", () => {
    const manifest = JSON.parse(readFileSync("plugins/alibaba-token-plan/plugin.json", "utf8"))
    expect(manifest.id).toBe("alibaba-token-plan")
    expect(manifest.name).toBe("Alibaba Token Plan")
    expect(manifest.config.fields.map((field) => field.id)).toEqual(["cookieHeader"])
    expect(manifest.lines.map((line) => line.label)).toEqual(["Token Quota", "Remaining", "Expires"])
  })

  it("throws when cookie is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No Alibaba Token Plan cookie found.")
  })

  it("loads subscription summary from manual cookie", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { ALIBABA_TOKEN_PLAN_COOKIE: "login_aliyunid_ticket=ticket; sec_token=console-session-value; csrf=csrf-header-value" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        Data: {
          SubscriptionSummary: {
            TotalValue: 1000000,
            TotalSurplusValue: 750000,
            TotalCount: 1,
            NearestExpireDate: "2026-03-01T00:00:00Z",
          },
        },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const call = ctx.host.http.request.mock.calls[0][0]

    expect(call.url).toContain("GetSubscriptionSummary")
    expect(call.headers.Cookie).toContain("sec_token=console-session-value")
    expect(call.headers["x-csrf-token"]).toBe("csrf-header-value")
    expect(call.bodyText).toContain("sfm_tokenplanteams_dp_cn")
    expect(result.plan).toBe("Token Plan")
    expect(result.lines.find((line) => line.label === "Token Quota").used).toBe(250000)
    expect(result.lines.find((line) => line.label === "Token Quota").limit).toBe(1000000)
    expect(result.lines.find((line) => line.label === "Remaining").value).toBe("750K")
    expect(result.lines.find((line) => line.label === "Expires").value).toBe("2026-03-01")
  })

  it("throws when login expires", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { ALIBABA_TOKEN_PLAN_COOKIE: "login_aliyunid_ticket=ticket; sec_token=console-session-value" })
    ctx.host.http.request.mockReturnValue({ status: 403, bodyText: "{}" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow(
      "Alibaba Token Plan login expired. Copy a fresh console Cookie header."
    )
  })

  it("throws when quota data is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { ALIBABA_TOKEN_PLAN_COOKIE: "login_aliyunid_ticket=ticket; sec_token=console-session-value" })
    ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ Data: {} }) })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Alibaba Token Plan response missing quota data.")
  })

  it("expands nested JSON strings from console responses", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { ALIBABA_TOKEN_PLAN_COOKIE: "login_aliyunid_ticket=ticket" })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        data: JSON.stringify({
          result: {
            totalValue: "200",
            totalSurplusValue: "125",
          },
        }),
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Token Quota").used).toBe(75)
    expect(result.lines.find((line) => line.label === "Token Quota").limit).toBe(200)
  })
})
