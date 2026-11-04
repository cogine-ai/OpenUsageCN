(function () {
  const { readNumber, money, failure, settings, get } = globalThis.__openrouterCommon
  function pushCreditsLine(ctx, lines, credits) {
    const total = readNumber(credits && credits.total_credits)
    const usage = readNumber(credits && credits.total_usage)
    if (total === null || total < 0 || usage === null || usage < 0) {
      throw failure("error", "Account credits response invalid. Try again later.")
    }
    if (total >= 0) {
      if (total > 0) {
        lines.push(ctx.line.progress({
          label: "Credits",
          used: usage,
          limit: total,
          format: { kind: "dollars" },
        }))
      }
      lines.push(ctx.line.text({ label: "Balance", value: money(Math.max(0, total - usage)) }))
    }
  }

  function pushKeyLines(ctx, lines, key) {
    const limit = readNumber(key && key.limit)
    if (limit !== null && limit > 0) {
      const remaining = readNumber(key.limit_remaining)
      let usage = remaining === null ? null : limit - remaining
      if (key.limit_remaining === undefined && key.limit_reset == null) {
        usage = readNumber(key.usage)
        if (key.include_byok_in_limit === true) {
          const byok = readNumber(key.byok_usage)
          usage = usage !== null && byok !== null ? usage + byok : null
        }
      }
      if (usage === null || !Number.isFinite(usage) || usage < 0) {
        ctx.host.log.error("OpenRouter key quota has invalid or missing current-window counters")
        throw "Key quota is unavailable. Try again later."
      }
      lines.push(ctx.line.progress({
        label: "Key Limit",
        used: usage,
        limit,
        format: { kind: "dollars" },
      }))
    }
    for (const item of [
      ["Daily Spend", key && key.usage_daily],
      ["Weekly Spend", key && key.usage_weekly],
      ["Monthly Spend", key && key.usage_monthly],
    ]) {
      const n = readNumber(item[1])
      if (n !== null) lines.push(ctx.line.text({ label: item[0], value: money(n) }))
    }
  }


  function listedSpend(ctx, config, deadline) {
    const totals = { daily: 0, weekly: 0, monthly: 0 }
    const byok = { daily: 0, weekly: 0, monthly: 0 }
    const hasByok = { daily: true, weekly: true, monthly: true }
    const seen = Object.create(null)
    for (let page = 0, offset = 0; page < 50; page++) {
      const data = get(ctx, config, "/keys?include_disabled=true&include_expired=true&offset=" + offset, deadline)
      if (!Array.isArray(data.data)) throw failure("error", "Key list response invalid. Try again later.")
      for (const key of data.data) {
        if (!key || typeof key.hash !== "string" || !key.hash || seen[key.hash]) {
          throw failure("error", "Key list pagination is incomplete. Try again later.")
        }
        seen[key.hash] = true
        for (const period of Object.keys(totals)) {
          const value = readNumber(key["usage_" + period])
          if (value === null || value < 0) throw failure("error", "Key usage response invalid. Try again later.")
          totals[period] += value
          const extra = readNumber(key["byok_usage_" + period])
          if (extra === null) hasByok[period] = false
          else if (extra < 0) throw failure("error", "BYOK usage response invalid. Try again later.")
          else byok[period] += extra
          if (!Number.isFinite(totals[period]) || !Number.isFinite(byok[period])) {
            throw failure("error", "Key usage response invalid. Try again later.")
          }
        }
      }
      // The upstream API returns pages of 100. A short page is terminal.
      if (data.data.length < 100) return { totals, byok, hasByok }
      offset += data.data.length
    }
    throw failure("error", "Key list pagination is incomplete. Try again later.")
  }

  function probe(ctx) {
    const config = settings(ctx)
    const deadline = Date.now() + 25000
    let keyResponse
    try { keyResponse = get(ctx, config, "/key", deadline) } catch (error) {
      ctx.host.log.error("OpenRouter key metadata unavailable: " + (error.reportStatus || "error"))
      const available = []
      try { pushCreditsLine(ctx, available, get(ctx, config, "/credits", deadline).data) } catch (_) { throw error }
      if (!available.length) throw error
      available.push(ctx.line.badge({ label: "Key Status", text: "Key Usage Unavailable", color: "#a3a3a3" }))
      return { plan: null, lines: available }
    }
    const key = keyResponse.data
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      throw failure("error", "Key usage response invalid. Try again later.")
    }
    const lines = []
    if (key.is_management_key === true) {
      if (key.workspace_id != null && (typeof key.workspace_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key.workspace_id))) {
        throw failure("error", "Key workspace response invalid. Try again later.")
      }
      const spend = listedSpend(ctx, config, deadline)
      lines.push(ctx.line.text({ label: "Key Scope", value: key.workspace_id ? "Workspace Keys" : "Default Workspace Keys", subtitle: "Management Key. Listed keys only; Activity reports have their own scope." }))
      for (const period of ["daily", "weekly", "monthly"]) {
        const title = period.charAt(0).toUpperCase() + period.slice(1)
        lines.push(ctx.line.text({ label: "Listed Keys " + title + " Spend", value: money(spend.totals[period]) }))
        if (spend.hasByok[period]) lines.push(ctx.line.text({ label: "BYOK " + title + " Spend", value: money(spend.byok[period]) }))
      }
    } else {
      if (key.is_management_key !== undefined && key.is_management_key !== false) {
        throw failure("error", "Key type response invalid. Try again later.")
      }
      pushKeyLines(ctx, lines, key)
    }
    try {
      const credits = get(ctx, config, "/credits", deadline)
      pushCreditsLine(ctx, lines, credits.data)
    } catch (error) {
      ctx.host.log.warn("OpenRouter balance unavailable: " + (error.reportStatus || "error"))
      lines.push(ctx.line.badge({ label: "Balance Status", text: "Balance Unavailable", color: "#a3a3a3" }))
      if (lines.length === 1) throw error
    }
    if (!lines.length) lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    return { plan: key.is_free_tier ? "Free Tier" : null, lines }
  }

  globalThis.__openusage_plugin = { id: "openrouter", probe,
    probeReports: function (ctx) { return globalThis.__openrouterReports(ctx) } }
})()
