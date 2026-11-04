import { describe, expect, it } from "vitest"
import { makeCtx } from "../test-helpers.js"
import { loadTestPlugin } from "../load-test-plugin.js"

const row = (fields = {}) => ({ model_name: "general", current_interval_used_percent: "8%", current_interval_total_percent: "100%", remains_time: 3600000, current_weekly_used_percent: "45%", current_weekly_total_percent: "150%", weekly_remains_time: 7200000, ...fields })
function context(rows = [row()]) {
  const ctx = makeCtx()
  ctx.host.config.get.mockImplementation((name) => ({ source: "webChina", webCookie: "HERTZ-SESSION=fixture-cookie" })[name] ?? null)
  ctx.host.http.request.mockReturnValue({ status: 200, bodyText: JSON.stringify({ base_resp: { status_code: 0 }, model_remains: rows }) })
  return ctx
}
describe("MiniMax China web source", () => {
  it("reads the current Cookie endpoint with independent interval and boosted weekly quotas", () => {
    const ctx = context(), result = loadTestPlugin("minimax").probe(ctx)
    expect(result.lines.filter((l) => l.type === "progress").map((l) => [l.label, l.used, l.limit])).toEqual([["Session", 8, 100], ["Weekly", 30, 100]])
    expect(result.lines.find((l) => l.label === "Weekly Capacity").value).toBe("150% of base quota")
    expect(result.lines.find((l) => l.label === "Session").resetsAt).toBe("2026-02-02T01:00:00.000Z")
    expect(ctx.host.http.request.mock.calls[0][0]).toMatchObject({ method: "GET", url: "https://www.minimax.cn/backend/account/token_plan/remains_percent", headers: { Cookie: "HERTZ-SESSION=fixture-cookie", Origin: "https://platform.minimax.cn" } })
    expect(ctx.host.env.get).not.toHaveBeenCalled()
  })
  it.each(["weekly_boost_permille", "weekly_boost_permill"])("handles legacy remaining-percent fields and boost spelling %s without applying the boost twice", (boost) => {
    const ctx = context([{ model_name: "general", current_interval_remaining_percent: 100, current_weekly_remaining_percent: 70, current_weekly_total_count: 0, current_weekly_usage_count: 0, [boost]: 1500 }])
    const result = loadTestPlugin("minimax").probe(ctx)
    expect(result.lines.find((l) => l.label === "Weekly").used).toBe(30)
    expect(result.lines.find((l) => l.label === "Weekly Capacity").value).toBe("150% of base quota")
  })
  it("does not apply a display-only boost to used percentage when total percentage is absent", () => {
    const ctx = context([{ model_name: "general", current_weekly_used_percent: 45, weekly_boost_permille: 1500 }])
    const lines = loadTestPlugin("minimax").probe(ctx).lines
    expect(lines.find((line) => line.label === "Weekly").used).toBe(45)
    expect(lines.find((line) => line.label === "Weekly Capacity").value).toBe("150% of base quota")
  })
  it("represents unlimited text windows as text without progress or reset and ignores absent video lanes", () => {
    const ctx = context([row({ current_interval_used_percent: "0%", current_interval_total_percent: "0%", current_interval_status: 3, current_weekly_used_percent: "0%", current_weekly_status: 3 }), { model_name: "video", current_interval_status: 3, current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 100 }])
    expect(loadTestPlugin("minimax").probe(ctx).lines).toEqual([{ type: "text", label: "Session", value: "Unlimited" }, { type: "text", label: "Weekly", value: "Unlimited" }])
  })
  it("does not call an excluded zero-count interval unlimited when only the weekly plan is unlimited", () => {
    const ctx = context([{ model_name: "general", current_interval_status: 3, current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 100, current_weekly_status: 3, current_weekly_remaining_percent: 100 }])
    expect(loadTestPlugin("minimax").probe(ctx).lines).toEqual([{ type: "text", label: "Weekly", value: "Unlimited" }])
  })
  it("uses actual epoch start/end for pacing and leaves unknown duration unset", () => {
    const ctx = context([row({ start_time: 1769990400000, end_time: 1770008400000 })])
    const result = loadTestPlugin("minimax").probe(ctx)
    expect(result.lines.find((l) => l.label === "Session").periodDurationMs).toBe(18000000)
    expect(result.lines.find((l) => l.label === "Weekly").periodDurationMs).toBeUndefined()
  })
  it.each([3600, 3600000])("handles a one-hour countdown in seconds or milliseconds (%s)", (countdown) => {
    const ctx = context([row({ remains_time: countdown, weekly_remains_time: countdown })])
    const lines = loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress")
    expect(lines.map((line) => line.resetsAt)).toEqual(["2026-02-02T01:00:00.000Z", "2026-02-02T01:00:00.000Z"])
  })
  it("interprets 900000 as milliseconds for both text windows rather than a ten-day reset", () => {
    const ctx = context([row({ remains_time: 900000, weekly_remains_time: 900000 })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").map((line) => line.resetsAt)).toEqual(["2026-02-02T00:15:00.000Z", "2026-02-02T00:15:00.000Z"])
  })
  it.each([[18000, 604800], [18000000, 604800000]])("preserves the documented window maximum in either supported unit (%s, %s)", (session, weekly) => {
    const ctx = context([row({ remains_time: session, weekly_remains_time: weekly })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").map((line) => line.resetsAt)).toEqual(["2026-02-02T05:00:00.000Z", "2026-02-09T00:00:00.000Z"])
  })
  it("uses milliseconds once a seconds interpretation exceeds its known window", () => {
    const ctx = context([row({ remains_time: 18001, weekly_remains_time: 604801 })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").map((line) => line.resetsAt)).toEqual(["2026-02-02T00:00:18.001Z", "2026-02-02T00:10:04.801Z"])
  })
  it("omits impossible countdowns while retaining quota and logging a fixed warning", () => {
    const ctx = context([row({ remains_time: 18000001, weekly_remains_time: 604800001 })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").every((line) => line.resetsAt === undefined)).toBe(true)
    expect(ctx.host.log.warn).toHaveBeenCalledWith("MiniMax quota countdown exceeds its known window; reset unavailable")
  })
  it("does not infer a countdown reset from an invalid explicit interval", () => {
    const ctx = context([row({ start_time: Date.parse("2026-02-01T23:00:00Z"), end_time: Date.parse("2026-02-01T22:00:00Z"), remains_time: 3600 })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.find((line) => line.label === "Session").resetsAt).toBeUndefined()
    expect(ctx.host.log.warn).toHaveBeenCalledWith("MiniMax quota countdown exceeds its known window; reset unavailable")
  })
  it("keeps an explicit future end ahead of countdown inference", () => {
    const end = "2026-02-02T02:00:00.000Z", ctx = context([row({ end_time: Date.parse(end), weekly_end_time: Date.parse(end), remains_time: 900000, weekly_remains_time: 900000 })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").map((line) => line.resetsAt)).toEqual([end, end])
  })
  it("uses an explicit actual interval duration instead of guessing a five-hour window", () => {
    const ctx = context([row({ start_time: Date.parse("2026-02-01T17:00:00Z"), end_time: Date.parse("2026-02-02T00:00:00Z"), remains_time: 21600 })])
    const session = loadTestPlugin("minimax").probe(ctx).lines.find((line) => line.label === "Session")
    expect(session.resetsAt).toBe("2026-02-02T06:00:00.000Z")
    expect(session.periodDurationMs).toBe(7 * 60 * 60 * 1000)
  })
  it("uses a valid countdown when the supplied end timestamp has already passed", () => {
    const ctx = context([row({ end_time: Date.parse("2026-02-01T23:00:00Z"), weekly_end_time: Date.parse("2026-02-01T23:30:00Z"), remains_time: 3600, weekly_remains_time: 3600000 })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").map((line) => line.resetsAt)).toEqual(["2026-02-02T01:00:00.000Z", "2026-02-02T01:00:00.000Z"])
  })
  it("accepts legacy m2.7 text-generation model aliases for session and weekly windows", () => {
    const ctx = context([row({ model_name: "m2.7" })])
    expect(loadTestPlugin("minimax").probe(ctx).lines.filter((line) => line.type === "progress").map((line) => [line.label, line.used])).toEqual([["Session", 8], ["Weekly", 30]])
  })
  it.each([[401, "expired"], [403, "denied"], [500, "HTTP 500"]])("does not fall back to API keys after HTTP %s", (status, message) => {
    const ctx = context();ctx.host.env.get.mockReturnValue("other-account-key")
    ctx.host.http.request.mockReturnValue({ status, bodyText: "RAW_SECRET_FAILURE" })
    expect(() => loadTestPlugin("minimax").probe(ctx)).toThrow(message)
    expect(ctx.host.env.get).not.toHaveBeenCalled()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ctx.host.log.error.mock.calls)).not.toContain("RAW_SECRET_FAILURE")
  })
  it.each(["{credential-secret", '{"base_resp":{"status_code":1004,"status_msg":"secret"}}', '{"model_remains":[]}', '{"model_remains":null}'])("rejects malformed, missing or rejected data without returning raw fields", (bodyText) => {
    const ctx = context();ctx.host.http.request.mockReturnValue({ status: 200, bodyText })
    let error;try { loadTestPlugin("minimax").probe(ctx) } catch (e) { error = e }
    expect(typeof error).toBe("string");expect(error).not.toContain("secret")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    expect(ctx.host.env.get).not.toHaveBeenCalled()
  })
  it("rejects a multiline Cookie before sending a request", () => {
    const ctx = context();ctx.host.config.get.mockImplementation((field) => field === "source" ? "webChina" : "session=bad\nheader=x")
    expect(() => loadTestPlugin("minimax").probe(ctx)).toThrow("invalid")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })
})
