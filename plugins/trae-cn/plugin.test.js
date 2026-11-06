import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

function usage(changes = {}) {
  return { is_credits_billing: true, usage_summary: { total_amount: 100, consumed_amount: 25 }, user_entitlement_pack_list: [{ group_type: 0, status: 1, display_desc: "Pro" }], ...changes }
}

async function setup(answer = usage()) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((key) => key === "cookie" ? "session=synthetic-private" : null)
  ctx.host.http.request.mockReturnValueOnce({ status: 200, bodyText: JSON.stringify({ Result: { Token: "short-lived-private" } }) })
    .mockReturnValueOnce({ status: 200, bodyText: JSON.stringify(answer) })
  await import("./plugin.js")
  return { ctx, plugin: globalThis.__openusage_plugin }
}

describe("Trae CN usage", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })

  it("declares China-only settings and a themeable mark", () => {
    const manifest = JSON.parse(readFileSync("plugins/trae-cn/plugin.json", "utf8"))
    expect(manifest).toMatchObject({ id: "trae-cn", brandColor: "#4D7CFE" })
    expect(manifest.config.fields[0].environmentVariables).toEqual(["TRAE_CN_COOKIE"])
    expect(readFileSync("plugins/trae-cn/icon.svg", "utf8")).toContain('fill="currentColor"')
  })

  it("exchanges and uses a refresh-local token only on the fixed China API origin", async () => {
    const { ctx, plugin } = await setup()
    const output = plugin.probe(ctx)
    expect(output.plan).toBe("Pro")
    expect(output.lines[0]).toMatchObject({ label: "Usage", used: 25, limit: 100 })
    const requests = ctx.host.http.request.mock.calls.map(([request]) => request)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://api.trae.cn/cloudide/api/v3/common/GetUserToken", bodyText: "{}", headers: { Cookie: "session=synthetic-private" } })
    expect(requests[1]).toMatchObject({ method: "POST", url: "https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list", bodyText: '{"require_usage":true,"full_data":true}', headers: { Authorization: "Cloud-IDE-JWT short-lived-private" } })
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
    expect(JSON.stringify(output)).not.toContain("private")
    expect(output.lines.every((line) => !line.resetsAt && !line.periodDurationMs)).toBe(true)
  })

  it("uses only TRAE_CN_COOKIE when Settings has no cookie", async () => {
    const { ctx, plugin } = await setup()
    ctx.host.config.get.mockReturnValue(null)
    ctx.host.env.get.mockReturnValue("env-session")
    plugin.probe(ctx)
    expect(ctx.host.env.get).toHaveBeenCalledWith("TRAE_CN_COOKIE")
    expect(ctx.host.http.request.mock.calls[0][0].headers.Cookie).toBe("env-session")
  })

  it("keeps both requests on the originally captured session if settings change mid-exchange", async () => {
    const { ctx, plugin } = await setup()
    ctx.host.http.request.mockReset().mockImplementationOnce(() => {
      ctx.host.config.get.mockReturnValue("session=another-account")
      return { status: 200, bodyText: '{"Result":{"Token":"first-account-token"}}' }
    }).mockReturnValueOnce({ status: 200, bodyText: JSON.stringify(usage()) })
    plugin.probe(ctx)
    expect(ctx.host.http.request.mock.calls[1][0].headers).toMatchObject({
      Cookie: "session=synthetic-private", Authorization: "Cloud-IDE-JWT first-account-token",
    })
  })

  it("requires a connection and rejects header injection without network access", async () => {
    const { ctx, plugin } = await setup()
    ctx.host.config.get.mockReturnValue(null)
    expect(() => plugin.probe(ctx)).toThrow("Add a Cookie header")
    ctx.host.config.get.mockReturnValue("session=x\r\nAuthorization: other")
    expect(() => plugin.probe(ctx)).toThrow("single request-header")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it.each([[401, "session expired"], [302, "session expired"], [403, "denied access"], [429, "rate limited"], [503, "request failed"]])("classifies token-exchange HTTP %s without changing account source", async (status, expected) => {
    const { ctx, plugin } = await setup()
    ctx.host.env.get.mockReturnValue("another-account")
    ctx.host.http.request.mockReset().mockReturnValue({ status, bodyText: "private upstream body" })
    expect(() => plugin.probe(ctx)).toThrow(expected)
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
  })

  it("classifies an entitlement auth rejection without persisting the exchanged token", async () => {
    const { ctx, plugin } = await setup({ code: 1001 })
    expect(() => plugin.probe(ctx)).toThrow("session expired")
    expect(ctx.host.fs.writeText).not.toHaveBeenCalled()
  })

  it.each([{ Result: {} }, { Result: { Token: "" } }, { Result: { Token: "bad\r\nheader" } }, "bad-json"])("rejects a malformed token exchange", async (body) => {
    const { ctx, plugin } = await setup()
    ctx.host.http.request.mockReset().mockReturnValue({ status: 200, bodyText: typeof body === "string" ? body : JSON.stringify(body) })
    expect(() => plugin.probe(ctx)).toThrow("response changed")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
  })

  it.each([usage({ is_credits_billing: false }), usage({ usage_summary: {} }), usage({ usage_summary: { total_amount: "100", consumed_amount: 1 } }), usage({ usage_summary: { total_amount: 100, consumed_amount: -1 } })])("rejects unknown billing or malformed quantities instead of showing zero", async (body) => {
    const { ctx, plugin } = await setup(body)
    expect(() => plugin.probe(ctx)).toThrow("response changed")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("retains zero allowance and fractional/over-limit counts", async () => {
    const { ctx, plugin } = await setup(usage({ usage_summary: { total_amount: 0, consumed_amount: 0 } }))
    expect(plugin.probe(ctx).lines).toEqual([
      { type: "text", label: "Used", value: "0 credits" },
      { type: "text", label: "Total", value: "0 credits" },
      { type: "text", label: "Remaining", value: "0 credits" },
    ])
    ctx.host.http.request.mockReturnValueOnce({ status: 200, bodyText: '{"Result":{"Token":"token"}}' }).mockReturnValueOnce({ status: 200, bodyText: JSON.stringify(usage({ usage_summary: { total_amount: 100, consumed_amount: 120.25 } })) })
    expect(plugin.probe(ctx).lines).toContainEqual({ type: "text", label: "Used", value: "120.25 credits" })
  })

  it("never logs token/body values for parse or transport failures", async () => {
    const { ctx, plugin } = await setup({ code: "private-account" })
    expect(() => plugin.probe(ctx)).toThrow("response changed")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private")
    ctx.host.http.request.mockReset().mockImplementation(() => { throw new Error("private-cookie") })
    expect(() => plugin.probe(ctx)).toThrow("Check your connection")
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("private-cookie")
  })

  it("does not round a reported tiny positive credit count into zero", async () => {
    const { ctx, plugin } = await setup(usage({ usage_summary: { total_amount: 100, consumed_amount: 0.001 } }))
    expect(plugin.probe(ctx).lines).toContainEqual({ type: "text", label: "Used", value: "<0.01 credits" })
  })
})
