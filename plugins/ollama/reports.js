(function () {
  const DAY = 86400000
  const METRICS = ["request_count", "usage_usd", "input_tokens", "cached_input_tokens", "output_tokens"]
  function totals(api, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw api.failure("error", "Ollama returned invalid daily usage.")
    const result = {}
    for (const field of METRICS) {
      if (raw[field] === undefined || raw[field] === null) continue
      const value = api.number(raw[field])
      if (value === null || (field !== "usage_usd" && !Number.isSafeInteger(value))) throw api.failure("error", "Ollama returned invalid daily usage.")
      result[field] = value
    }
    if (result.request_count === undefined || (result.cached_input_tokens !== undefined && result.input_tokens !== undefined && result.cached_input_tokens > result.input_tokens)) {
      throw api.failure("error", "Ollama returned invalid daily usage.")
    }
    return result
  }
  function modelBytes(model) {
    try { return (encodeURIComponent(model).match(/%[0-9A-F]{2}|./g) || []).length } catch (_) { return Infinity }
  }
  function parse(api, data, from, today) {
    if (data.granularity !== "day" || !Array.isArray(data.buckets)) throw api.failure("error", "Ollama returned an unsupported report format.")
    const days = new Map(), models = new Map()
    let incompleteModels = false
    for (const raw of data.buckets) {
      const start = api.iso(raw && raw.from), end = api.iso(raw && raw.until)
      const ms = start && Date.parse(start), until = end && Date.parse(end)
      if (!start || !end || ms % DAY !== 0 || ms < from || ms > today || until <= ms || until > ms + DAY || days.has(start.slice(0, 10))) {
        throw api.failure("error", "Ollama returned invalid or duplicate report dates.")
      }
      const count = totals(api, raw)
      days.set(start.slice(0, 10), count)
      if (raw.remainder !== undefined && raw.remainder !== null) incompleteModels = true
      if (raw.groups === undefined) { if (count.request_count > 0) incompleteModels = true; continue }
      if (!Array.isArray(raw.groups)) throw api.failure("error", "Ollama returned invalid model usage.")
      const seen = new Set()
      let groupedRequests = 0
      for (const group of raw.groups) {
        const model = group && group.model
        if (typeof model !== "string" || !model.trim() || /[\u0000-\u001f\u007f]/.test(model) || modelBytes(model) > 200 || seen.has(model)) throw api.failure("error", "Ollama returned invalid or duplicate model usage.")
        seen.add(model)
        const values = totals(api, group), prior = models.get(model) || []
        groupedRequests += values.request_count
        prior.push(values)
        models.set(model, prior)
      }
      if (!Number.isSafeInteger(groupedRequests) || groupedRequests > count.request_count) throw api.failure("error", "Ollama returned inconsistent model usage.")
      if (groupedRequests < count.request_count) incompleteModels = true
    }
    return { days, models, incompleteModels }
  }
  function read(ctx, api, apiKey, range, today, deadline) {
    const from = today - Number(range.slice(0, -1)) * DAY
    const coverage = { fromDate: new Date(from).toISOString().slice(0, 10), toDate: new Date(today).toISOString().slice(0, 10), timeZone: "UTC", reportedDates: [], missingDates: [] }
    const meta = { id: range, label: range.toUpperCase() + " Model Usage", status: "ready", coverage }
    try {
      const data = api.request(ctx, apiKey, "/api/usage?range=" + range + "&group_by=model", "GET", deadline)
      const parsed = parse(api, data, from, today)
      coverage.reportedDates = Array.from(parsed.days.keys()).sort()
      for (let date = from; date <= today; date += DAY) {
        const label = new Date(date).toISOString().slice(0, 10)
        if (!parsed.days.has(label)) coverage.missingDates.push(label)
      }
      const lines = [], prefix = range.toUpperCase() + " "
      const buckets = coverage.reportedDates.map((date) => parsed.days.get(date))
      if (buckets.length) {
        const total = (field) => {
          if (!buckets.every((value) => value[field] !== undefined)) return null
          const value = buckets.reduce((sum, item) => sum + item[field], 0)
          if (!Number.isFinite(value) || (field !== "usage_usd" && !Number.isSafeInteger(value))) throw api.failure("error", "Ollama report usage exceeds the supported range.")
          return value
        }
        const requests = total("request_count")
        if (!Number.isSafeInteger(requests)) throw api.failure("error", "Ollama report usage exceeds the supported range.")
        lines.push(ctx.line.text({ label: prefix + "Requests", value: String(requests) }))
        lines.push(ctx.line.barChart({ label: prefix + "Daily Requests (UTC)", points: coverage.reportedDates.map((date) => ({ label: date, value: parsed.days.get(date).request_count })), note: "Server-reported dates only; range includes today." }))
        for (const spec of [["input_tokens", "Input Tokens"], ["cached_input_tokens", "Cached Input Tokens"], ["output_tokens", "Output Tokens"], ["usage_usd", "Usage Value"]]) {
          const value = total(spec[0])
          if (value !== null && Number.isFinite(value)) lines.push(ctx.line.text({ label: prefix + spec[1], value: spec[0] === "usage_usd" ? "$" + value.toFixed(4) : String(value) }))
        }
        if (!parsed.incompleteModels) {
          const models = Array.from(parsed.models.entries()).map(([model, groups]) => {
            const values = {}
            for (const field of METRICS) {
              if (!groups.every((group) => group[field] !== undefined)) continue
              values[field] = groups.reduce((sum, group) => sum + group[field], 0)
              if (!Number.isFinite(values[field]) || (field !== "usage_usd" && !Number.isSafeInteger(values[field]))) throw api.failure("error", "Ollama model usage exceeds the supported range.")
            }
            return { model, values }
          }).sort((a, b) => b.values.request_count - a.values.request_count || a.model.localeCompare(b.model))
          if (models.length > 100) {
            meta.status = "partial"
            meta.message = "Only the top 100 models by reported requests are shown."
          }
          for (const entry of models.slice(0, 100)) {
            const values = entry.values, parts = [values.request_count + " requests"]
            if (values.input_tokens !== undefined) parts.push(values.input_tokens + " input tokens")
            if (values.cached_input_tokens !== undefined) parts.push(values.cached_input_tokens + " cached input tokens (included in input)")
            if (values.output_tokens !== undefined) parts.push(values.output_tokens + " output tokens")
            if (values.usage_usd !== undefined) parts.push("$" + values.usage_usd.toFixed(4) + " usage value")
            lines.push(ctx.line.text({ label: prefix + "Model: " + entry.model, value: parts.join(" · ") }))
          }
        }
      }
      if (coverage.missingDates.length || parsed.incompleteModels) {
        meta.status = "partial"
        meta.message = [meta.message, parsed.incompleteModels ? "Daily totals are available; model breakdown is incomplete." : "Some UTC dates were not reported. Missing dates are not zero usage."].filter(Boolean).join(" ")
      }
      if (!buckets.length) meta.message = "No usage dates were reported."
      return { meta, lines }
    } catch (error) {
      ctx.host.log.warn("Ollama " + range + " report unavailable")
      return { meta: { ...meta, status: error.status || "error", message: error.message || "Could not load the Ollama report." }, lines: [] }
    }
  }
  globalThis.__openusage_ollama_reports = function (ctx) {
    const api = globalThis.__openusage_ollama_api, selected = api.source(ctx)
    if (selected === "cookie") return { scopeKey: ctx.host.crypto.sha256Hex("ollama:cookie:reports-not-supported"), lines: [], reports: [{ id: "usage", label: "Model Usage", status: "notSupported", message: "Select API Key in Settings to load server reports." }] }
    if (selected !== "apiKey") throw "Ollama source is invalid. Check Settings."
    const apiKey = api.key(ctx), deadline = Date.now() + 25000
    try {
      const before = api.request(ctx, apiKey, "/api/me", "POST", deadline)
      const account = api.identity(before)
      const expected = ctx.host.config.get("managedAccountFingerprint")
      if (expected && globalThis.__openusage_ollama_account_identity(ctx, before).fingerprint !== expected) throw api.failure("authExpired", "Ollama account identity changed. Re-verify this connection.")
      const now = Date.parse(ctx.nowIso), today = Math.floor(now / DAY) * DAY
      if (!Number.isFinite(today)) throw api.failure("error", "Could not determine the Ollama report window.")
      const results = ["7d", "30d"].map((range) => read(ctx, api, apiKey, range, today, deadline))
      const afterAccount = api.request(ctx, apiKey, "/api/me", "POST", deadline)
      const after = api.identity(afterAccount)
      if (expected && globalThis.__openusage_ollama_account_identity(ctx, afterAccount).fingerprint !== expected) throw api.failure("authExpired", "Ollama account identity changed. Re-verify this connection.")
      if (api.source(ctx) !== selected || api.key(ctx) !== apiKey || after !== account) throw api.failure("authExpired", "Ollama account changed. Refresh usage and reload reports.")
      return { scopeKey: ctx.host.crypto.sha256Hex(JSON.stringify(["ollama", selected, apiKey, account])), lines: results.flatMap((result) => result.lines), reports: results.map((result) => result.meta) }
    } catch (error) {
      ctx.host.log.error("Ollama reports could not be loaded safely")
      throw error.message || "Could not load Ollama reports. Check Settings and try again."
    }
  }
})()
