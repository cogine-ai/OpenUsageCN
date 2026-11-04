(function () {
  const BASE = "https://chatgpt.com/backend-api/wham/"
  const DAY = 86400000
  const TEAM = ["team", "self_serve_business_prolite", "self_serve_business_usage_based", "sci", "sci_plus"]
  const ENTERPRISE = ["business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro"]
  const TOKEN_FIELDS = [
    ["text_total_tokens", "Tokens"], ["uncached_text_input_tokens", "Input Tokens"],
    ["cached_text_input_tokens", "Cached Input Tokens"], ["text_output_tokens", "Output Tokens"],
  ]
  function selectSource(ctx, paths, allowKeychain, parseAuth, keychainService) {
    const invalid = () => {
      ctx.host.log.error("Codex report credential source is invalid or unreadable")
      return "Codex report credentials are invalid or unreadable. Check login file permissions or refresh Codex usage."
    }
    const decode = (raw, source, authPath) => {
      if (typeof raw !== "string" || !raw.trim()) throw invalid()
      const auth = parseAuth(raw)
      if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw invalid()
      const tokens = auth.tokens
      if (tokens != null && (typeof tokens !== "object" || Array.isArray(tokens))) throw invalid()
      const token = tokens && tokens.access_token
      if (token != null && (typeof token !== "string" || !token || token.trim() !== token)) throw invalid()
      if (tokens && tokens.account_id != null && typeof tokens.account_id !== "string") throw invalid()
      if (auth.OPENAI_API_KEY != null && typeof auth.OPENAI_API_KEY !== "string") throw invalid()
      if (!token && !(typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim())) throw invalid()
      return { auth, source, authPath, rawDigest: ctx.host.crypto.sha256Hex(raw) }
    }
    for (const path of paths) {
      let exists
      try { exists = ctx.host.fs.existsStrict(path) } catch (_) { throw invalid() }
      if (!exists) continue
      let raw
      try { raw = ctx.host.fs.readText(path) } catch (_) { throw invalid() }
      // The first present file is authoritative even when damaged. Do not try another login.
      return decode(raw, "file", path)
    }
    if (!allowKeychain) return null
    let raw
    try { raw = ctx.host.keychain.readGenericPassword(keychainService) } catch (_) { throw invalid() }
    if (raw === null || raw === undefined) return null
    return decode(raw, "keychain", null)
  }
  function identity(ctx, state) {
    const tokens = state.auth && state.auth.tokens
    const payload = tokens && ctx.jwt.decodePayload(tokens.access_token)
    const subject = payload && payload.sub
    const workspace = tokens && tokens.account_id
    if (typeof subject !== "string" || !subject || subject.trim() !== subject || subject.length > 512 || /[\u0000-\u001f\u007f]/.test(subject) ||
        typeof workspace !== "string" || !workspace || workspace.trim() !== workspace || workspace.length > 512 || /[\u0000-\u001f\u007f]/.test(workspace)) {
      throw "Reports need a ChatGPT login with a complete account identity. Refresh Codex usage and try again."
    }
    return { subject, workspace, expiresAt: payload.exp }
  }
  function binding(ctx, state) {
    const id = identity(ctx, state)
    return JSON.stringify(["codex-reports-v1", state.source, state.authPath, id.subject, id.workspace, state.rawDigest])
  }
  function number(value, allowNegative) {
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) throw "Invalid report number"
    const result = Number(value)
    if (!Number.isFinite(result) || (!allowNegative && (result < 0 || !Number.isSafeInteger(result)))) throw "Invalid report number"
    return result
  }
  function dateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw "Invalid report date"
    const key = value.slice(0, 10)
    const date = new Date(key + "T00:00:00Z")
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) throw "Invalid report date"
    return key
  }
  function windowAt(now) {
    const end = new Date(now).toISOString().slice(0, 10)
    const startMs = new Date(end + "T00:00:00Z").getTime() - 29 * DAY
    const dates = []
    for (let i = 0; i < 30; i++) dates.push(new Date(startMs + i * DAY).toISOString().slice(0, 10))
    return { dates, fromDate: dates[0], toDate: end }
  }
  function coverage(window, days) {
    return {
      fromDate: window.fromDate, toDate: window.toDate, timeZone: "UTC",
      reportedDates: window.dates.filter((day) => Object.prototype.hasOwnProperty.call(days, day)),
      missingDates: window.dates.filter((day) => !Object.prototype.hasOwnProperty.call(days, day)),
    }
  }
  function records(body) {
    if (!body || !Array.isArray(body.data) || body.data.length > 10000) throw "Invalid report rows"
    if (body.has_more === true || body.hasMore === true || body.next_cursor || body.nextCursor || body.next ||
        (body.pagination && (body.pagination.has_more || body.pagination.next_cursor || body.pagination.next))) {
      throw "Report has unread pages"
    }
    return body.data
  }
  function accumulate(days, date, values) {
    const day = days[date] || (days[date] = Object.create(null))
    for (const key of Object.keys(values)) {
      day[key] = (day[key] || 0) + values[key]
      if (!Number.isFinite(day[key]) || (key !== "Credits" && !Number.isSafeInteger(day[key]))) throw "Report total overflow"
    }
  }
  function parseCounts(body, window) {
    const days = Object.create(null)
    for (const row of records(body)) {
      const date = dateKey(row.date)
      if (date < window.fromDate || date > window.toDate) throw "Report date outside requested window"
      if (!row.totals || typeof row.totals !== "object") throw "Invalid report totals"
      const values = { Turns: number(row.totals.turns, false) }
      for (const [field, name] of TOKEN_FIELDS) {
        if (row.totals[field] != null) values[name] = number(row.totals[field], false)
      }
      // totals.credits can be relative plan usage. It is not the charged credits report.
      accumulate(days, date, values)
      const models = row.models == null ? [] : row.models
      if (!Array.isArray(models)) throw "Invalid model counts"
      for (const model of models) {
        const values = Object.create(null)
        if (model.turns != null) values.Turns = number(model.turns, false)
        if (model.text_total_tokens != null) values.Tokens = number(model.text_total_tokens, false)
        addModel(days[date], model.model, values)
      }
    }
    return days
  }
  function addModel(day, name, values) {
    if (typeof name !== "string" || !name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) throw "Invalid model name"
    const models = day.models || (day.models = Object.create(null))
    const model = models[name] || (models[name] = Object.create(null))
    for (const key of Object.keys(values)) {
      model[key] = (model[key] || 0) + values[key]
      if (!Number.isFinite(model[key]) || (key !== "Credits" && !Number.isSafeInteger(model[key]))) throw "Model total overflow"
    }
  }
  function parseCredits(body, window, kind) {
    const days = Object.create(null)
    for (const row of records(body)) {
      const date = dateKey(row.date)
      if (date < window.fromDate || date > window.toDate) throw "Report date outside requested window"
      const values = kind === "team"
        ? row.premium_usage_values && row.premium_usage_values.credit_usage_credits : row.values
      // Relative/percentage reports have no charged-credit values. Leave these days unreported.
      if (values == null) continue
      if (typeof values !== "object" || Array.isArray(values)) throw "Invalid charged credit values"
      let total = 0
      for (const name of Object.keys(values)) total += number(values[name], true)
      if (!Number.isFinite(total)) throw "Credit total overflow"
      accumulate(days, date, { Credits: total })
      if (kind === "enterprise") {
        for (const name of Object.keys(values)) addModel(days[date], name, { Credits: number(values[name], true) })
      } else {
        const models = row.models == null ? [] : row.models
        if (!Array.isArray(models)) throw "Invalid model credits"
        for (const model of models) {
          if (model.on_demand_credits != null) addModel(days[date], model.model, { Credits: number(model.on_demand_credits, true) })
        }
      }
    }
    return days
  }
  function request(ctx, token, workspace, path, query, id, label, now) {
    let response
    try {
      response = ctx.util.request({ method: "GET", url: BASE + path + query,
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "ChatGPT-Account-Id": workspace }, timeoutMs: 15000 })
    } catch (error) {
      ctx.host.log.error("Codex server report transport failed: " + id)
      return { report: { id, label, status: "error", message: "Report request failed. Try again later." } }
    }
    const report = { id, label, status: "ready" }
    if (response.status === 401) { report.status = "authExpired"; report.message = "Refresh Codex usage, then load reports again." }
    else if (response.status === 403) { report.status = "permissionDenied"; report.message = "This login cannot read this report." }
    else if (response.status === 429) {
      report.status = "rateLimited"; report.message = "Report is rate limited. Try again later."
      const headers = response.headers || {}
      const retry = headers["retry-after"] || headers["Retry-After"]
      const seconds = typeof retry === "string" && /^\d+$/.test(retry) ? Number(retry) : null
      const at = seconds !== null ? now + seconds * 1000 : Date.parse(retry)
      if (Number.isFinite(at) && at > now && at <= now + 7 * DAY) report.retryAt = new Date(at).toISOString()
    } else if (response.status < 200 || response.status >= 300) {
      report.status = "error"; report.message = "Report request failed (HTTP " + response.status + ")."
    }
    if (report.status !== "ready") { ctx.host.log.warn("Codex server report unavailable: " + id + " HTTP " + response.status); return { report } }
    if (typeof response.bodyText !== "string" || response.bodyText.length > 4 * 1024 * 1024) {
      ctx.host.log.error("Codex server report response rejected: " + id); report.status = "error"; report.message = "Report response is too large or invalid."; return { report }
    }
    const body = ctx.util.tryParseJson(response.bodyText)
    if (!body || typeof body !== "object") { ctx.host.log.error("Codex server report response rejected: " + id); report.status = "error"; report.message = "Report response is invalid."; return { report } }
    return { report, body }
  }
  function addLines(ctx, lines, days, names, credits) {
    for (const name of names) {
      const dates = Object.keys(days).sort().filter((date) => days[date][name] !== undefined)
      if (!dates.length) continue
      let total = 0
      for (const date of dates) total += days[date][name]
      if (!Number.isFinite(total) || (!credits && !Number.isSafeInteger(total))) throw "Report total overflow"
      lines.push(ctx.line.text({ label: "Reported " + name, value: String(total) + " " + name.toLowerCase() }))
      if (credits) {
        // Existing sparklines cannot represent negative adjustments. Preserve signed daily credits as text.
        for (const date of dates) lines.push(ctx.line.text({ label: date + " Charged Credits", value: String(days[date][name]) + " credits" }))
      } else {
        lines.push(ctx.line.barChart({ label: "Daily " + name, points: dates.map((date) => ({ label: date, value: days[date][name], valueLabel: String(days[date][name]) + " " + name.toLowerCase() })), note: "UTC dates reported by ChatGPT; missing dates are not zero." }))
      }
    }
  }
  function addModelLines(ctx, lines, days) {
    const totals = Object.create(null)
    for (const date of Object.keys(days)) {
      for (const name of Object.keys(days[date].models || {})) {
        const model = days[date].models[name]
        for (const metric of Object.keys(model)) {
          const key = JSON.stringify([name, metric])
          totals[key] = (totals[key] || 0) + model[metric]
          if (!Number.isFinite(totals[key]) || (metric !== "Credits" && !Number.isSafeInteger(totals[key]))) throw "Model total overflow"
        }
      }
    }
    const names = Array.from(new Set(Object.keys(totals).map((key) => JSON.parse(key)[0]))).sort()
    for (const name of names.slice(0, 100)) {
      for (const metric of ["Credits", "Tokens", "Turns"]) {
        const key = JSON.stringify([name, metric])
        if (!Object.prototype.hasOwnProperty.call(totals, key)) continue
        lines.push(ctx.line.text({ label: "Model " + metric + ": " + name, value: String(totals[key]) + " " + metric.toLowerCase(), subtitle: "Reported model attribution only" }))
      }
    }
    return names.length > 100
  }
  function readReport(ctx, session, window, path, suffix, id, label, parse, names, credits, now) {
    const query = "?start_date=" + window.fromDate + "&end_date=" + window.toDate + suffix
    const result = request(ctx, session.token, session.workspace, path, query, id, label, now)
    const lines = []
    if (result.body) {
      try {
        const days = parse(result.body, window)
        result.report.coverage = coverage(window, days)
        if (result.report.coverage.missingDates.length) result.report.status = "partial"
        addLines(ctx, lines, days, names, credits)
        if (addModelLines(ctx, lines, days)) {
          result.report.status = "partial"
          result.report.message = "Only the first 100 reported models by name are shown. Daily totals are unchanged."
        }
      } catch (error) {
        ctx.host.log.error("Codex server report response rejected: " + id)
        result.report.status = "error"; result.report.message = "Report data is invalid or incomplete. Try again later."
        lines.length = 0
      }
    }
    return { report: result.report, lines }
  }
  function probe(ctx, state, reread) {
    const now = Date.now()
    if (state.auth && state.auth.OPENAI_API_KEY && !(state.auth.tokens && state.auth.tokens.access_token)) {
      return { scopeKey: ctx.host.crypto.sha256Hex(JSON.stringify(["codex-reports-v1", state.source, state.authPath, state.rawDigest])),
        lines: [], reports: [{ id: "counts", label: "Tokens And Turns", status: "notSupported", message: "Server reports require a ChatGPT login, not an API key." }] }
    }
    const rawBinding = binding(ctx, state)
    const scopeKey = ctx.host.crypto.sha256Hex(rawBinding)
    const id = identity(ctx, state)
    const assertCurrent = () => {
      if (binding(ctx, reread()) !== rawBinding) throw "Codex credentials changed. Refresh usage and load reports again."
    }
    assertCurrent()
    const session = { token: state.auth.tokens.access_token, workspace: id.workspace }
    if (typeof id.expiresAt === "number" && id.expiresAt * 1000 <= now) {
      return { scopeKey, lines: [], reports: [{ id: "counts", label: "Tokens And Turns", status: "authExpired", message: "Refresh Codex usage, then load reports again." }] }
    }
    const window = windowAt(now)
    const counts = readReport(ctx, session, window, "analytics/daily-workspace-usage-counts", "&group_by=day&workspace_user=true", "counts", "Tokens And Turns", parseCounts, ["Tokens", "Turns", "Input Tokens", "Cached Input Tokens", "Output Tokens"], false, now)
    // Plan selection is tied to the same accepted bearer/workspace, not a cached quota from another login.
    const planResult = request(ctx, session.token, session.workspace, "usage", "", "plan", "Credit Report Availability", now)
    const reports = [counts.report]
    const lines = counts.lines
    const plan = planResult.body && typeof planResult.body.plan_type === "string" ? planResult.body.plan_type.toLowerCase() : null
    const kind = TEAM.includes(plan) ? "team" : ENTERPRISE.includes(plan) ? "enterprise" : null
    if (kind) {
      const path = kind === "team" ? "usage/daily-workspace-user-token-usage-breakdown" : "usage/daily-workspace-user-credit-usage"
      const suffix = kind === "team" ? "&group_by=day" : "&breakdown=model"
      const credits = readReport(ctx, session, window, path, suffix, "credits", "Charged Credits", (body, range) => parseCredits(body, range, kind), ["Credits"], true, now)
      reports.push(credits.report); lines.push(...credits.lines)
    } else if (!planResult.body || !plan) {
      reports.push(Object.assign({}, planResult.report, { id: "credits", label: "Charged Credits", status: planResult.report.status === "ready" ? "error" : planResult.report.status,
        message: planResult.report.message || "The current plan could not be identified." }))
    } else {
      reports.push({ id: "credits", label: "Charged Credits", status: "notSupported", message: "This plan has no supported charged-credit report. Tokens and turns remain separate." })
    }
    assertCurrent()
    return { scopeKey, lines, reports }
  }
  globalThis.__openusage_codex_reports = { probe, selectSource }
})()
