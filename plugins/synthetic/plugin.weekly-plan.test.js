import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

async function probe(payload) {
  const ctx = makeCtx()
  ctx.host.env.get.mockImplementation((key) => key === "SYNTHETIC_API_KEY" ? "synthetic-key" : null)
  ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify(payload) })
  await import("./plugin.js")
  return { ctx, output: globalThis.__openusage_plugin.probe(ctx) }
}
const legacy = { subscription: { limit: 500, requests: 100 }, freeToolCalls: { limit: 10, requests: 2 }, rollingFiveHourLimit: { max: 100, remaining: 0, limited: true }, weeklyTokenLimit: { percentRemaining: 10 }, search: { hourly: { limit: 250, requests: 5 } } }

describe("Synthetic Weekly Plan", () => {
  beforeEach(() => { vi.resetModules(); delete globalThis.__openusage_plugin })

  it.each([false, true])("prefers the new weekly plan with wrapped=%s and retains only search", async (wrapped) => {
    const body = { ...legacy, planWeeklyLimit: { percentRemaining: 99.47981765714286, nextRegenAt: "2026-11-07T00:30:00+08:00", nextRegenPercent: 2 } }
    const { output } = await probe(wrapped ? { data: body } : body)
    expect(output.lines.map((line) => line.label)).toEqual(["Weekly", "Next Regen", "Regen Percent", "Search"])
    expect(output.lines[0].used).toBeCloseTo(0.52018234285714)
    expect(output.lines[1]).toMatchObject({ value: "2026-11-06T16:30:00.000Z", subtitle: "UTC · Partial Regeneration, Not A Full Reset" })
    expect(output.lines[2].value).toBe("2%")
    expect(output.lines[0].resetsAt).toBeUndefined()
    expect(output.lines[0].periodDurationMs).toBeUndefined()
  })

  it.each([0, 0.5, 1, 100])("treats remaining %s as percentage points", async (remaining) => {
    const { output } = await probe({ planWeeklyLimit: { percentRemaining: remaining, nextRegenPercent: 0.5 } })
    expect(output.lines[0].used).toBe(100 - remaining)
    expect(output.lines[1].value).toBe("0.5%")
  })

  it.each([null, [], {}, { percentRemaining: "50" }, { percentRemaining: -1 }, { percentRemaining: 101 }])("does not revive retired allowances for invalid new data: %o", async (planWeeklyLimit) => {
    await expect(probe({ ...legacy, planWeeklyLimit })).rejects.toThrow("Synthetic weekly plan usage is unavailable")
  })

  it("keeps a valid weekly value when optional regen metadata is malformed", async () => {
    const { output, ctx } = await probe({ planWeeklyLimit: { percentRemaining: 0, nextRegenAt: "tomorrow", nextRegenPercent: "private-value" } })
    expect(output.lines[0]).toMatchObject({ label: "Weekly", used: 100 })
    expect(output.lines.slice(1).map((line) => line.value)).toEqual(["Unavailable", "Unavailable"])
    expect(ctx.host.log.warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(ctx.host.log.warn.mock.calls)).not.toContain("private-value")
  })

  it("keeps the old protocol when the new field is absent", async () => {
    const { output } = await probe(legacy)
    expect(output.lines.map((line) => line.label)).toEqual(["5h Rate Limit", "Mana Bar", "Rate Limited", "Search"])
  })
})
