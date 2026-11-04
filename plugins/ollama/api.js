(function () {
  const BASE = "https://ollama.com"
  function source(ctx) {
    try { return ctx.host.config.get("source") || "cookie" } catch (_) {
      ctx.host.log.error("Ollama source configuration could not be read")
      throw "Could not read Ollama Cloud settings. Try again."
    }
  }
  function key(ctx) {
    let value
    try { value = ctx.host.config.get("apiKey") || ctx.host.env.get("OLLAMA_API_KEY") } catch (_) {
      ctx.host.log.error("Ollama API key configuration could not be read")
      throw "Could not read Ollama Cloud settings. Try again."
    }
    if (typeof value !== "string" || !value.trim()) throw "Ollama API key missing. Add it in Settings or set OLLAMA_API_KEY."
    value = value.trim()
    if (/[\u0000-\u0020\u007f]/.test(value)) throw "Ollama API key is invalid. Check Settings."
    return value
  }
  function failure(status, message) { return { status, message } }
  function request(ctx, apiKey, path, method, deadline) {
    const timeoutMs = deadline ? Math.min(10000, deadline - Date.now()) : 10000
    if (timeoutMs <= 0) throw failure("error", "Ollama report time limit reached. Try again.")
    let response
    try {
      response = ctx.util.request({ method: method || "GET", url: BASE + path,
        headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" }, timeoutMs })
    } catch (_) {
      ctx.host.log.error("Ollama JSON request failed")
      throw failure("error", "Could not reach Ollama Cloud. Check your connection.")
    }
    const code = response.status
    if (code === 401) throw failure("authExpired", "Ollama API key expired or was rejected. Check Settings.")
    if (code === 403) throw failure("permissionDenied", "Ollama denied access to this report or account data.")
    if (code === 429) throw failure("rateLimited", "Ollama rate limit reached. Try again later.")
    if (code < 200 || code >= 300) throw failure("error", "Ollama request failed (HTTP " + code + "). Try again later.")
    let data
    try { data = JSON.parse(response.bodyText) } catch (_) {
      throw failure("error", "Ollama returned invalid usage data. Try again later.")
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw failure("error", "Ollama returned invalid usage data. Try again later.")
    return data
  }
  function number(value) {
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null
    if (typeof value === "string" && !/^\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  function iso(value) {
    if (typeof value !== "string" || !value.trim()) return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  function plan(account) {
    const value = account.Plan === undefined ? account.plan : account.Plan
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  function quota(ctx, loadedBalance, loadedAccount) {
    try {
      const apiKey = key(ctx), balance = loadedBalance || request(ctx, apiKey, "/api/balance")
      const included = balance.included
      if (!included || typeof included !== "object" || Array.isArray(included)) throw failure("error", "Ollama returned no supported usage windows.")
      const lines = []
      const allowance = number(included.allowance_usd), available = number(included.balance_usd)
      if (allowance !== null && allowance > 0 && available !== null) {
        const period = included.period || {}, from = iso(period.from), until = iso(period.until)
        const line = { label: "Monthly", used: Math.max(0, Math.min(allowance, allowance - available)),
          limit: allowance, format: { kind: "dollars" } }
        if (until) line.resetsAt = until
        if (from && until && Date.parse(until) > Date.parse(from)) line.periodDurationMs = Date.parse(until) - Date.parse(from)
        lines.push(ctx.line.progress(line))
      }
      for (const entry of [["session", "Session"], ["weekly", "Weekly"]]) {
        const item = included[entry[0]], remaining = item && number(item.remaining_percent)
        if (remaining === null || remaining === undefined || remaining > 100) continue
        lines.push(ctx.line.progress({ label: entry[1], used: 100 - remaining, limit: 100,
          format: { kind: "percent" }, resetsAt: iso(item.resets_at) || undefined }))
      }
      const purchased = balance.purchased && number(balance.purchased.balance_usd)
      if (purchased !== null && purchased !== undefined) lines.push(ctx.line.text({ label: "Purchased Credits", value: "$" + purchased.toFixed(2) }))
      const period = included.period || {}, from = iso(period.from), until = iso(period.until)
      const knownZeroAllowance = allowance === 0 && available !== null && from && until && Date.parse(until) > Date.parse(from)
      const knownPurchased = purchased !== null && purchased !== undefined
      if (!lines.some((line) => line.type === "progress") && !(knownZeroAllowance && knownPurchased)) throw failure("error", "Ollama returned no supported usage windows.")
      let accountPlan
      try {
        accountPlan = plan(loadedAccount || request(ctx, apiKey, "/api/me", "POST"))
        if (!accountPlan) throw failure("error", "Account plan missing")
      } catch (_) {
        ctx.host.log.warn("Ollama account plan details unavailable; quota remains available")
        lines.push(ctx.line.text({ label: "Account Details", value: "Unavailable", subtitle: "Plan details could not be loaded. Quota remains available." }))
      }
      return { plan: accountPlan ? ctx.fmt.planLabel(accountPlan) : undefined, lines }
    } catch (error) {
      ctx.host.log.error("Ollama JSON quota could not be loaded")
      throw typeof error === "string" ? error : error.message || "Could not load Ollama usage. Try again."
    }
  }
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}"
    return JSON.stringify(value)
  }
  function identity(account) {
    const fields = ["id", "Id", "ID", "user_id", "userId", "UserID", "email", "Email", "username", "Username", "Name", "name"]
    const found = {}
    for (const field of fields) {
      const value = account[field]
      if ((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isSafeInteger(value))) found[field] = value
    }
    if (!Object.keys(found).length) throw failure("error", "Ollama account identity is unavailable. Sign in again.")
    return stable(found)
  }
  globalThis.__openusage_ollama_api = { source, key, request, number, iso, identity, quota, failure }
})()
