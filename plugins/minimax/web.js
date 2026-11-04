(function () {
  const URL = "https://www.minimax.cn/backend/account/token_plan/remains_percent"
  function number(raw) {
    if (typeof raw !== "number" && typeof raw !== "string") return null
    const text = String(raw).trim().replace(/%$/, "")
    if (!text || !/^\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null
    const value = Number(text)
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  function cookie(ctx) {
    const raw = ctx.host.config.get("webCookie")
    if (typeof raw !== "string" || !raw.trim()) throw "MiniMax China Web needs a Cookie header. Add it in Settings."
    const value = raw.trim().replace(/^cookie:\s*/i, "")
    if (/[\u0000-\u001f\u007f]/.test(value) || !value.split(";").every((part) => /^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]+\s*$/.test(part))) {
      throw "MiniMax Cookie header is invalid. Copy it from the China usage page."
    }
    return value
  }
  function date(raw) {
    const value = number(raw)
    if (value === null) return null
    const ms = value < 1e10 ? value * 1000 : value
    return Number.isFinite(new Date(ms).getTime()) ? ms : null
  }
  function window(ctx, row, weekly) {
    const name = weekly ? "Weekly" : "Session", prefix = weekly ? "current_weekly_" : "current_interval_"
    const used = number(row[prefix + "used_percent"]), totalPercent = number(row[prefix + "total_percent"])
    const remaining = number(row[prefix + "remaining_percent"]), total = number(row[prefix + "total_count"]), left = number(row[prefix + "usage_count"])
    const status = number(row[prefix + "status"])
    if (status === 3 && (used !== null || (weekly && remaining !== null && remaining >= 100))) {
      return [ctx.line.text({ label: name, value: "Unlimited" })]
    }
    if (status === 3 && (!total || total === 0) && (!left || left === 0) && remaining >= 100) return []
    const boost = number(row[(weekly ? "weekly" : "interval") + "_boost_permille"]) ?? number(row[(weekly ? "weekly" : "interval") + "_boost_permill"])
    const capacity = totalPercent !== null && totalPercent > 0 ? totalPercent : boost !== null && boost > 0 ? boost / 10 : 100
    let percent
    if (remaining !== null && remaining <= 100) percent = 100 - remaining
    else if (used !== null) percent = used / (totalPercent !== null && totalPercent > 0 ? totalPercent : 100) * 100
    else if (total !== null && total > 0 && left !== null) percent = (total - left) / total * 100
    else return []
    const opts = { label: name, used: Math.max(0, Math.min(100, percent)), limit: 100, format: { kind: "percent" }, limitResourceKey: weekly ? "weekly" : "session" }
    const end = date(row[weekly ? "weekly_end_time" : "end_time"]), start = date(row[weekly ? "weekly_start_time" : "start_time"])
    const remains = number(row[weekly ? "weekly_remains_time" : "remains_time"])
    const now = Date.parse(ctx.nowIso)
    if (end !== null && end > now) opts.resetsAt = new Date(end).toISOString()
    else if (remains !== null && remains > 0 && Number.isFinite(now)) {
      const milliseconds = remains > 1000000 ? remains : remains * 1000
      if (Number.isFinite(new Date(now + milliseconds).getTime())) opts.resetsAt = new Date(now + milliseconds).toISOString()
    }
    if (start !== null && end !== null && end > start) opts.periodDurationMs = end - start
    const lines = [ctx.line.progress(opts)]
    if (capacity !== 100) lines.push(ctx.line.text({ label: name + " Capacity", value: capacity + "% of base quota" }))
    return lines
  }
  globalThis.__openusage_minimax_web = function (ctx) {
    try {
      const value = cookie(ctx)
      const resp = ctx.util.request({ method: "GET", url: URL, timeoutMs: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", Cookie: value, Accept: "application/json, text/plain, */*", Origin: "https://platform.minimax.cn", Referer: "https://platform.minimax.cn/console/usage", "X-Requested-With": "XMLHttpRequest" } })
      if (resp.status === 401) throw "MiniMax web session expired. Sign in again and update the Cookie header."
      if (resp.status === 403) throw "MiniMax denied access to the China usage page. Check your account permissions."
      if (resp.status < 200 || resp.status >= 300) throw "MiniMax web usage request failed (HTTP " + resp.status + "). Try again later."
      let data
      try { data = JSON.parse(resp.bodyText) } catch (_) { throw "MiniMax returned invalid web usage data." }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw "MiniMax returned invalid web usage data."
      const body = data.data && typeof data.data === "object" ? data.data : data
      const base = body.base_resp || data.base_resp
      if (base && number(base.status_code) !== 0) {
        if (number(base.status_code) === 1004) throw "MiniMax web session expired. Sign in again and update the Cookie header."
        throw "MiniMax could not load web usage. Check your account and try again."
      }
      if (!Array.isArray(body.model_remains)) throw "MiniMax returned invalid web usage data."
      const rows = body.model_remains.filter((row) => row && typeof row.model_name === "string" && (/^(general|text[ -]?generation)$|^m2\./i.test(row.model_name.trim()) || row.model_name.toLowerCase().includes("minimax-m")))
      const row = rows.find((item) => item.model_name.trim().toLowerCase() === "general") || rows[0]
      if (!row) throw "MiniMax returned no supported coding quota windows."
      const lines = window(ctx, row, false).concat(window(ctx, row, true))
      if (!lines.length) throw "MiniMax returned no supported coding quota windows."
      return { lines }
    } catch (error) {
      ctx.host.log.error("MiniMax China web usage could not be loaded")
      throw typeof error === "string" ? error : "Could not load MiniMax web usage. Check Settings and your connection."
    }
  }
})()
