(function () {
  const DAY_MS = 86400000
  function utcDay(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
    const ms = Date.parse(value + "T00:00:00Z")
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null
  }

  function coverage(now) {
    const end = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") - DAY_MS
    const dates = []
    for (let i = 29; i >= 0; i--) dates.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10))
    return { fromDate: dates[0], toDate: dates[29], timeZone: "UTC", reportedDates: [], missingDates: dates }
  }

  function parseActivity(data, range, number, failure) {
    if (!data || !Array.isArray(data.data)) throw failure("error", "Activity response invalid. Try again later.")
    const days = Object.create(null)
    const models = Object.create(null)
    let requests = 0, tokens = 0, spend = 0, byok = 0, hasByok = true
    for (const row of data.data) {
      if (!row || !utcDay(row.date) || row.date < range.fromDate || row.date > range.toDate ||
          typeof row.model !== "string" || !row.model.trim()) {
        throw failure("error", "Activity response has invalid dates or models. Try again later.")
      }
      const values = {}
      for (const field of ["usage", "requests", "prompt_tokens", "completion_tokens"]) {
        const value = number(row[field])
        if (value === null || value < 0 || (field !== "usage" && !Number.isSafeInteger(value))) {
          throw failure("error", "Activity counters invalid. Try again later.")
        }
        values[field] = value
      }
      for (const field of ["cached_tokens", "reasoning_tokens", "byok_usage_inference"]) {
        if (row[field] != null && (number(row[field]) === null || number(row[field]) < 0)) {
          throw failure("error", "Activity counters invalid. Try again later.")
        }
      }
      const extra = number(row.byok_usage_inference)
      if (extra === null) hasByok = false
      else byok += extra
      const count = values.prompt_tokens + values.completion_tokens
      tokens += count
      requests += values.requests
      spend += values.usage
      days[row.date] = (days[row.date] || 0) + values.usage
      if (!models[row.model]) models[row.model] = { spend: 0, tokens: 0, requests: 0 }
      models[row.model].spend += values.usage
      models[row.model].tokens += count
      models[row.model].requests += values.requests
    }
    if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(requests) || ![spend, byok].every(Number.isFinite)) throw failure("error", "Activity totals invalid. Try again later.")
    range.reportedDates = Object.keys(days).sort()
    range.missingDates = range.missingDates.filter((day) => !Object.prototype.hasOwnProperty.call(days, day))
    return { days, models, requests, tokens, spend, byok, hasByok }
  }

  function probeReports(ctx) {
    const h = globalThis.__openrouterCommon
    let config
    try { config = h.settings(ctx) } catch (error) {
      return { scopeKey: ctx.host.crypto.sha256Hex("openrouter:unconfigured"), lines: [], reports: [
        { id: "activity", label: "Activity", status: error.reportStatus || "error", message: error.message }
      ] }
    }
    const range = coverage(Date.now())
    let workspace = null
    let identity = null
    let scope = h.scopeKey(ctx, config, identity)
    const lines = []
    const report = { id: "activity", label: "Activity", status: "error", coverage: range }
    const deadline = Date.now() + 25000
    try {
      const response = h.get(ctx, config, "/key", deadline)
      const key = response.data
      if (!key || typeof key.is_management_key !== "boolean") throw h.failure("error", "Key type response invalid. Try again later.")
      identity = { workspace: key.workspace_id == null ? null : key.workspace_id,
        organization: key.organization_id == null ? null : key.organization_id,
        creator: key.creator_user_id == null ? null : key.creator_user_id }
      for (const value of Object.values(identity)) {
        if (value !== null && (typeof value !== "string" || !value.trim())) throw h.failure("error", "Key identity response invalid. Try again later.")
      }
      scope = h.scopeKey(ctx, config, identity)
      if (key.is_management_key === false) {
        report.status = "notSupported"
        report.message = "Activity reports require an OpenRouter management key."
      } else {
        if (key.workspace_id != null) {
          if (typeof key.workspace_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key.workspace_id)) {
            throw h.failure("error", "Key workspace response invalid. Try again later.")
          }
          workspace = key.workspace_id
        }
        scope = h.scopeKey(ctx, config, identity)
        const path = "/activity" + (workspace ? "?workspace_id=" + encodeURIComponent(workspace) : "")
        const parsed = parseActivity(h.get(ctx, config, path, deadline), range, h.readNumber, h.failure)
        lines.push(ctx.line.text({ label: "Activity Scope", value: workspace ? "Workspace Activity" : "Account Activity",
          subtitle: "Last 30 completed UTC days. Separate from Listed Keys Spend." }))
        if (range.reportedDates.length) {
          lines.push(ctx.line.barChart({ label: "Daily Activity Spend", points: range.reportedDates.map((date) => ({
            label: date, value: parsed.days[date], valueLabel: h.money(parsed.days[date])
          })), note: "OpenRouter platform spend. Unreported dates are omitted; BYOK is separate." }))
          lines.push(ctx.line.text({ label: "Activity Spend", value: h.money(parsed.spend) }))
          lines.push(ctx.line.text({ label: "Activity Requests", value: String(parsed.requests) }))
          lines.push(ctx.line.text({ label: "Activity Tokens", value: String(parsed.tokens) }))
          if (parsed.hasByok) lines.push(ctx.line.text({ label: "Activity BYOK Spend", value: h.money(parsed.byok) }))
          for (const model of Object.keys(parsed.models).sort()) {
            const value = parsed.models[model]
            lines.push(ctx.line.text({ label: model, value: h.money(value.spend),
              subtitle: value.requests + " requests · " + value.tokens + " tokens" }))
          }
        }
        report.status = range.missingDates.length ? "partial" : "ready"
        if (!range.reportedDates.length) report.message = "No activity rows were reported for this window."
        else if (range.missingDates.length) report.message = "Some dates have no reported activity. They are not counted as zero."
      }
    } catch (error) {
      report.status = error.reportStatus || "error"
      report.message = error.reportStatus ? error.message : "Activity request failed. Try again later."
      ctx.host.log.error("OpenRouter activity unavailable: " + report.status)
    }
    // Never publish a result captured before the connection configuration changed.
    let current
    try { current = h.settings(ctx) } catch (_) { throw "OpenRouter connection changed. Refresh reports again." }
    if (h.scopeKey(ctx, current, identity) !== scope) throw "OpenRouter connection changed. Refresh reports again."
    return { scopeKey: scope, lines, reports: [report] }
  }

  globalThis.__openrouterReports = probeReports
})()
