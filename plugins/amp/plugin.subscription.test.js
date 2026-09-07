import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const subscriptionText = (other, orb, suffix = " - resets upon renewal in 29 days") =>
  "Signed in as private-person@example.com (private-user)\n"
  + "Subscription Megawatt: " + other + "% other usage and " + orb + "% orb usage remaining" + suffix

const prepare = async (text) => {
  const ctx = makeCtx()
  ctx.host.fs.writeText("~/.local/share/amp/secrets.json", JSON.stringify({
    "apiKey@https://ampcode.com/": "test-api-key",
  }))
  ctx.host.http.request.mockReturnValue({
    status: 200,
    bodyText: JSON.stringify({ ok: true, result: { displayText: text } }),
  })
  await import("./plugin.js")
  return { ctx, plugin: globalThis.__openusage_plugin }
}

describe("Amp Paid Subscriptions", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("shows Other and Orb usage with an approximate renewal hint", async () => {
    const { ctx, plugin } = await prepare(subscriptionText(97, 100))
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Megawatt")
    expect(result.lines).toEqual([
      { type: "progress", label: "Other Usage", used: 3, limit: 100, format: { kind: "percent" } },
      { type: "progress", label: "Orb Usage", used: 0, limit: 100, format: { kind: "percent" } },
      { type: "text", label: "Renews", value: "约 29 天" },
    ])
  })

  it.each([0, 0.25, 12.5, 99.75, 100])("preserves valid remaining percentages including %s", async (remaining) => {
    const { ctx, plugin } = await prepare(subscriptionText(remaining, remaining, ""))
    const result = plugin.probe(ctx)
    expect(result.lines).toHaveLength(2)
    for (const line of result.lines) {
      expect(line.used).toBeCloseTo(100 - remaining, 10)
      expect(line.limit).toBe(100)
      expect(line.resetsAt).toBeUndefined()
      expect(line.periodDurationMs).toBeUndefined()
    }
  })

  it("does not turn a one-day renewal hint into an exact reset or pace window", async () => {
    const { ctx, plugin } = await prepare(subscriptionText(12.5, 40, " - resets upon renewal in 1 day"))
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Renews").value).toBe("约 1 天")
    for (const line of result.lines.filter((line) => line.type === "progress")) {
      expect(line.resetsAt).toBeUndefined()
      expect(line.periodDurationMs).toBeUndefined()
    }
  })

  it.each([0, 5.25])("keeps explicit subscription credits %s without a false zero balance", async (credits) => {
    const { ctx, plugin } = await prepare(subscriptionText(97, 100)
      + "\nIndividual credits: $" + credits + " remaining - https://ampcode.com/settings")
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Megawatt")
    const line = result.lines.find((line) => line.label === "Credits")
    if (credits > 0) expect(line.value).toBe("$5.25")
    else expect(line).toBeUndefined()
  })

  it.each([
    ["negative", "-1"],
    ["negative fraction", "-0.25"],
    ["over 100", "101"],
    ["over 100 fraction", "100.01"],
    ["infinity", "Infinity"],
    ["NaN", "NaN"],
    ["exponent", "1e309"],
    ["overflow", "9".repeat(400)],
  ])("rejects %s in either pool even when valid credits are also present", async (_name, invalid) => {
    for (const [other, orb] of [[invalid, 100], [100, invalid]]) {
      const { ctx, plugin } = await prepare(subscriptionText(other, orb)
        + "\nIndividual credits: $0 remaining - https://ampcode.com/settings")
      expect(() => plugin.probe(ctx)).toThrow("Could not parse usage data")
      expect(ctx.host.log.error).toHaveBeenCalled()
    }
  })

  it.each([
    "Subscription Megawatt: usage format changed\nIndividual credits: $0 remaining",
    "Signed in as private-person@example.com (private-user)",
    { otherUsage: "unknown" },
  ])("fails safely for unrecognized usage without logging account text", async (text) => {
    const { ctx, plugin } = await prepare(text)
    expect(() => plugin.probe(ctx)).toThrow("Could not parse usage data")
    expect(ctx.host.log.error).toHaveBeenCalled()
    const logs = JSON.stringify([ctx.host.log.error.mock.calls, ctx.host.log.warn.mock.calls, ctx.host.log.info.mock.calls])
    expect(logs).not.toContain("private-person")
    expect(logs).not.toContain("private-user")
    expect(logs).not.toContain("Signed in as")
    expect(logs).not.toContain("usage format changed")
  })

  it("declares stable numeric keys and keeps the approximate renewal text outside those resources", () => {
    const manifest = JSON.parse(readFileSync("plugins/amp/plugin.json", "utf8"))
    expect(manifest.lines.filter((line) => line.limitResource).map((line) => [line.label, line.limitResource.key])).toEqual([
      ["Free", "free"], ["Other Usage", "other"], ["Orb Usage", "orb"],
    ])
    expect(manifest.lines.find((line) => line.label === "Renews")).toEqual({ type: "text", label: "Renews", scope: "detail" })
  })
})
