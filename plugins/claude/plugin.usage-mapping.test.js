import "./usage-mapping.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

async function probe(data) {
  const ctx = makeCtx()
  ctx.host.fs.exists = () => true
  ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-oauth", subscriptionType: "pro" } })
  ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(data) })
  await import("./plugin.js")
  return { ctx, output: globalThis.__openusage_plugin.probe(ctx) }
}
const scoped = (name = "Fable", changes = {}) => ({ kind: "weekly_scoped", group: "weekly", percent: 0.5, resets_at: "2026-12-01T00:00:00Z", scope: { model: { id: name, display_name: name } }, ...changes })
const extra = (changes = {}) => ({ is_enabled: true, used_credits: 1234, monthly_limit: 10000, ...changes })

describe("Claude Scoped Weekly And Original Currency", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })

  it.each([["USD", 2, 12.34, 100], ["USD", 3, 1.234, 10]])("keeps USD numeric resources with %s exponent %i", async (currency, decimal_places, used, limit) => {
    const { output } = await probe({ extra_usage: extra({ currency, decimal_places }) })
    expect(output.lines).toContainEqual({ type: "progress", label: "Extra usage spent", used, limit, format: { kind: "dollars" } })
  })

  it.each([["JPY", 0, "1234", "10000"], ["EUR", 2, "12.34", "100.00"], ["BHD", 3, "1.234", "10.000"]])("shows %s in original units without a USD budget", async (currency, decimal_places, used, limit) => {
    const { output } = await probe({ extra_usage: extra({ currency, decimal_places }) })
    expect(output.lines).toEqual([{ type: "text", label: "Extra Spent", value: currency + " " + used }, { type: "text", label: "Extra Limit", value: currency + " " + limit }])
    expect(output.lines.some((line) => line.type === "progress")).toBe(false)
  })

  it("defaults only absent currency and exponent to USD and two places", async () => {
    const { output } = await probe({ extra_usage: extra() })
    expect(output.lines[0]).toMatchObject({ used: 12.34, limit: 100 })
  })

  it("preserves fractional minor-unit amounts instead of rejecting old readable spending", async () => {
    const { output } = await probe({ extra_usage: extra({ used_credits: 123.4 }) })
    expect(output.lines[0]).toMatchObject({ used: 1.234, limit: 100 })
  })

  it.each([-0.1, 100.1])("skips scoped percentages outside the protocol range: %s", async (percent) => {
    const { output, ctx } = await probe({ seven_day: { utilization: 20 }, limits: [scoped("Invalid", { percent }), scoped()] })
    expect(output.lines.map((line) => line.label)).toEqual(["Weekly", "Fable Weekly"])
    expect(ctx.host.log.warn).toHaveBeenCalledWith("Claude model weekly limit entry is unavailable")
  })

  it.each([0, undefined, null])("preserves zero spend without making a cap for %s", async (monthly_limit) => {
    const { output } = await probe({ extra_usage: extra({ currency: "JPY", decimal_places: 0, used_credits: 0, monthly_limit }) })
    expect(output.lines).toEqual([{ type: "text", label: "Extra Spent", value: "JPY 0" }])
  })

  it.each([{ currency: "" }, { currency: null }, { currency: "PRIVATE_ACCOUNT" }, { decimal_places: null }, { decimal_places: -1 }, { decimal_places: 2.5 }, { decimal_places: 99 }, { used_credits: null }, { used_credits: -1 }, { monthly_limit: "100" }])("keeps quotas when currency metadata is invalid: %o", async (changes) => {
    const { output, ctx } = await probe({ five_hour: { utilization: 20 }, extra_usage: extra(changes) })
    expect(output.lines.find((line) => line.label === "Session")).toBeDefined()
    expect(output.lines).toContainEqual({ type: "text", label: "Extra Spent", value: "Unavailable" })
    expect(ctx.host.log.warn).toHaveBeenCalledWith("Claude extra usage currency or amount is unavailable")
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("PRIVATE_ACCOUNT")
  })

  it("keeps Fable and other models in independent fractional detail windows", async () => {
    const { output } = await probe({ seven_day: { utilization: 10 }, limits: [scoped(), scoped("New Model")] })
    expect(output.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Fable Weekly", limitResourceKey: "fable", used: 0.5, limit: 100, periodDurationMs: 604800000 }),
      expect.objectContaining({ label: "New Model Weekly", used: 0.5 }),
      expect.objectContaining({ label: "Weekly", used: 10 }),
    ]))
  })

  it("replaces only exact same-model legacy lanes and does not merge Sonnet variants", async () => {
    const { output } = await probe({ seven_day_sonnet: { utilization: 99 }, seven_day_omelette: { utilization: 22 }, limits: [scoped("Sonnet Research"), scoped("Sonnet"), scoped("Claude Design")] })
    expect(output.lines.map((line) => line.label)).toEqual(["Sonnet Research Weekly", "Sonnet Weekly", "Claude Design Weekly"])
    expect(output.lines.find((line) => line.label === "Sonnet Weekly").limitResourceKey).toBe("sonnet")
  })

  it("ignores all-model duplicates, wrong windows, duplicate identities and malformed siblings", async () => {
    const { output, ctx } = await probe({ limits: [scoped(), scoped("Fable renamed", { scope: { model: { id: "Fable", display_name: "Fable renamed" } } }), scoped("All models"), scoped("Weekly", { scope: { model: { id: "claude/all_models", display_name: "Weekly" } } }), scoped("Monthly", { group: "monthly" }), scoped("Bad", { percent: "5" }), null] })
    expect(output.lines.map((line) => line.label)).toEqual(["Fable Weekly"])
    expect(ctx.host.log.warn).toHaveBeenCalled()
  })

  it("bounds external model names and never exports unknown model IDs", async () => {
    const name = "Unknown\u202e Model " + "Long ".repeat(40)
    const { output } = await probe({ limits: [scoped(name, { scope: { model: { id: "private-model-id", display_name: name } } })] })
    expect(output.lines[0].label.length).toBeLessThanOrEqual(87)
    expect(output.lines[0].label).not.toContain("\u202e")
    expect(output.lines[0].limitResourceKey).toBeUndefined()
    expect(JSON.stringify(output)).not.toContain("private-model-id")
  })
})
