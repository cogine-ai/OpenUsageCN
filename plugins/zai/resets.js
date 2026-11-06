(function () {
  const URL = "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL"
  const LABELS = ["5h Reset Coupons", "Weekly Reset Coupons"]
  function expiry(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null
    const timestamp = Date.parse(value.replace(" ", "T") + "+08:00")
    if (!Number.isFinite(timestamp)) return null
    const roundTrip = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
    return roundTrip === value ? timestamp : null
  }
  function window(ctx, data, key, now) {
    if (data[key] === undefined) {
      ctx.host.log.warn("Z.ai reset coupons window was not reported")
      return null
    }
    if (!Array.isArray(data[key])) throw new Error("invalid reset window")
    const result = []
    for (const record of data[key]) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid reset record")
      if (record.available !== true) continue
      const expiresAt = expiry(record.expireTime)
      if (!Number.isSafeInteger(record.recordId) || expiresAt === null || typeof record.grantType !== "string" || !record.grantType.trim()) {
        throw new Error("invalid available reset record")
      }
      if (expiresAt > now) result.push({ id: record.recordId, expiresAt, display: record.expireTime.slice(0, 16) })
    }
    return result.sort((a, b) => a.expiresAt - b.expiresAt || a.id - b.id)
  }
  function append(ctx, apiKey, lines, deadline) {
    let data = null
    try {
      const budget = Math.min(5000, deadline - Date.now())
      if (budget <= 0) throw new Error("optional read budget exhausted")
      const response = ctx.util.request({
        method: "GET", url: URL,
        headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" }, timeoutMs: budget,
      })
      if (response.status < 200 || response.status >= 300) throw new Error("request rejected")
      const parsed = ctx.util.tryParseJson(response.bodyText)
      if (!parsed || parsed.success === false || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) throw new Error("invalid response")
      data = parsed.data
    } catch (_) {
      ctx.host.log.warn("Z.ai reset coupons could not be read; quota remains available")
    }
    const now = Date.parse(ctx.nowIso)
    const windows = ["fiveHourResets", "weekResets"].map((key, index) => {
      let records = null
      if (data) {
        try { records = window(ctx, data, key, now) }
        catch (_) { ctx.host.log.warn("Z.ai reset coupons window contains invalid records") }
      }
      lines.push(ctx.line.text({ label: LABELS[index], value: records === null ? "Unavailable" : String(records.length) }))
      return records
    })
    let value = "Unavailable"
    if (windows.every((records) => records !== null)) {
      const records = windows[0].concat(windows[1]).sort((a, b) => a.expiresAt - b.expiresAt || a.id - b.id)
      value = records.length ? records[0].display : "None"
    }
    lines.push(ctx.line.text({ label: "Coupon Expiry", value, ...(value !== "None" && value !== "Unavailable" ? { subtitle: "UTC+08:00" } : {}) }))
  }
  globalThis.__openusage_zai_resets = { append }
})()
