(function () {
  const SUMMARY = "https://cursor.com/api/usage-summary"
  const STATUS = "https://cursor.com/api/dashboard/v2/usage-status?scope=user"

  function personal(summary) {
    return summary && typeof summary.membershipType === "string" &&
      summary.membershipType.toLowerCase().startsWith("unified_") &&
      typeof summary.limitType === "string" && summary.limitType.toLowerCase() === "user"
  }

  function parse(summary, payload, now) {
    if (!personal(summary) || !payload || payload.availability !== "available") return null
    const usage = payload.monthlyUsage
    if (!usage || typeof usage.usedCents !== "number" || !Number.isFinite(usage.usedCents) || usage.usedCents < 0 ||
      typeof usage.limitCents !== "number" || !Number.isFinite(usage.limitCents) || usage.limitCents < 0) return null
    const date = (value) => {
      if (typeof value !== "string") return NaN
      const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/)
      if (!parts) return NaN
      const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
      const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return NaN
      if (parts[8] !== "Z" && (Number(parts[8].slice(1, 3)) > 23 || Number(parts[8].slice(4)) > 59)) return NaN
      return Date.parse(value.replace(/\.(\d{3})\d+(Z|[+-]\d{2}:\d{2})$/, ".$1$2"))
    }
    const start = date(usage.periodStart), reset = date(usage.resetsAt), current = date(now)
    if (!Number.isFinite(start) || !Number.isFinite(reset) || !Number.isFinite(current) || start > current || current >= reset) return null
    return { used: usage.usedCents / 100, limit: usage.limitCents / 100, periodStart: usage.periodStart, resetsAt: usage.resetsAt }
  }

  function enrich(ctx, output, session) {
    // Existing request quotas stay binding; this read never changes history or included usage.
    if (!session) return output
    const request = (url) => {
      const response = ctx.util.request({ method: "GET", url, headers: {
        Cookie: "WorkosCursorSessionToken=" + session.sessionToken, Accept: "application/json",
      }, timeoutMs: 5000 })
      if (response.status !== 200) throw "unavailable"
      const body = ctx.util.tryParseJson(response.bodyText)
      if (!body || typeof body !== "object" || Array.isArray(body)) throw "unavailable"
      return body
    }
    let summary
    try { summary = request(SUMMARY) } catch (_) {
      ctx.host.log.warn("Cursor additional spending scope is unavailable")
      return output
    }
    if (!personal(summary)) return output
    let monthly
    try { monthly = parse(summary, request(STATUS), ctx.nowIso) } catch (_) { /* Fixed warning below. */ }
    if (!monthly) {
      ctx.host.log.warn("Cursor unified monthly additional spending is unavailable")
      return output
    }
    output.lines = output.lines.filter((line) => line.label !== "On-demand" && line.label !== "Billing Scope")
    output.lines.push(monthly.limit > 0 ? ctx.line.progress({
      label: "On-demand", limitResourceKey: "onDemand", used: monthly.used, limit: monthly.limit,
      format: { kind: "dollars" }, resetsAt: monthly.resetsAt,
      periodDurationMs: Date.parse(monthly.resetsAt) - Date.parse(monthly.periodStart),
    }) : ctx.line.text({ label: "On-demand", value: "USD " + monthly.used.toFixed(2), subtitle: "No Positive Spending Cap Reported" }))
    output.lines.push(ctx.line.text({ label: "Billing Scope", value: "Current User" }))
    return output
  }

  globalThis.__openusage_cursor_unified = { parse, enrich }
})()
