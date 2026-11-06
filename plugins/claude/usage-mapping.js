(function () {
  function scopedWeekly(ctx, data, lines) {
    if (data.limits == null) return
    if (!Array.isArray(data.limits)) {
      ctx.host.log.warn("Claude model weekly limits are unavailable")
      return
    }
    const identities = new Set(), names = new Set()
    for (const entry of data.limits) {
      if (!entry || entry.kind !== "weekly_scoped" || entry.group !== "weekly") continue
      const model = entry.scope && entry.scope.model
      const raw = model && model.display_name
      if (typeof raw !== "string" || !raw.trim() || typeof entry.percent !== "number" || !Number.isFinite(entry.percent) || entry.percent < 0 || entry.percent > 100) {
        ctx.host.log.warn("Claude model weekly limit entry is unavailable")
        continue
      }
      const name = Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim()).slice(0, 80).join("")
      if (!name) continue
      const normalized = name.toLowerCase()
      const id = typeof model.id === "string" && model.id.trim() ? model.id.trim().toLowerCase() : normalized
      if (normalized === "all models" || /(?:^|[\/_-])all[ _-]models$/.test(id)) continue
      if (identities.has(id) || names.has(normalized)) continue
      identities.add(id); names.add(normalized)
      // Only exact known names identify a legacy lane. A model merely containing
      // "Sonnet" must not suppress a different legacy Sonnet budget.
      const legacy = normalized === "sonnet" ? "Sonnet" : normalized === "claude design" ? "Claude Design" : null
      if (legacy) {
        for (let index = lines.length - 1; index >= 0; index--) {
          if (lines[index].label === legacy) lines.splice(index, 1)
        }
      }
      const options = { label: name + " Weekly", used: entry.percent, limit: 100, format: { kind: "percent" }, periodDurationMs: 7 * 24 * 60 * 60 * 1000 }
      if (normalized === "fable") options.limitResourceKey = "fable"
      else if (legacy === "Sonnet") options.limitResourceKey = "sonnet"
      else if (legacy === "Claude Design") options.limitResourceKey = "claudeDesign"
      if (typeof entry.resets_at === "string" && Number.isFinite(Date.parse(entry.resets_at))) options.resetsAt = new Date(entry.resets_at).toISOString()
      else if (entry.resets_at != null) ctx.host.log.warn("Claude model weekly reset is unavailable")
      lines.push(ctx.line.progress(options))
    }
  }

  function extraUsage(ctx, data, lines) {
    const extra = data.extra_usage
    if (!extra || extra.is_enabled !== true) return
    const currency = extra.currency === undefined ? "USD" : typeof extra.currency === "string" ? extra.currency.toUpperCase() : ""
    const decimals = extra.decimal_places === undefined ? 2 : extra.decimal_places
    const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isInteger(decimals) || decimals < 0 || decimals > 6 || !amount(extra.used_credits) ||
      extra.monthly_limit != null && !amount(extra.monthly_limit)) {
      ctx.host.log.warn("Claude extra usage currency or amount is unavailable")
      lines.push(ctx.line.text({ label: "Extra Spent", value: "Unavailable" }))
      return
    }
    const used = extra.used_credits / Math.pow(10, decimals)
    const limit = extra.monthly_limit == null ? null : extra.monthly_limit / Math.pow(10, decimals)
    if (currency === "USD" && limit > 0) {
      lines.push(ctx.line.progress({ label: "Extra usage spent", used, limit, format: { kind: "dollars" } }))
    } else {
      lines.push(ctx.line.text({ label: currency === "USD" ? "Extra usage spent" : "Extra Spent", value: currency + " " + used.toFixed(decimals) }))
      if (limit > 0) lines.push(ctx.line.text({ label: "Extra Limit", value: currency + " " + limit.toFixed(decimals) }))
    }
  }

  globalThis.__openusage_claude_usage = { scopedWeekly, extraUsage }
})()
