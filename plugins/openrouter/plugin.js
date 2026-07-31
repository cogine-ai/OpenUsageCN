(function () {
  const DEFAULT_API_URL = "https://openrouter.ai/api/v1"

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }

  function getConfig(ctx, key) {
    try {
      return ctx.host.config && ctx.host.config.get ? readString(ctx.host.config.get(key)) : null
    } catch (e) {
      ctx.host.log.warn("config read failed for " + key + ": " + String(e))
      return null
    }
  }

  function getEnv(ctx, key) {
    try {
      return ctx.host.env && ctx.host.env.get ? readString(ctx.host.env.get(key)) : null
    } catch (e) {
      ctx.host.log.warn("env read failed for " + key + ": " + String(e))
      return null
    }
  }

  function loadApiKey(ctx) {
    return getConfig(ctx, "apiKey") || getEnv(ctx, "OPENROUTER_API_KEY")
  }

  function normalizeApiUrl(ctx, value) {
    const raw = readString(value) || DEFAULT_API_URL
    const withScheme = raw.indexOf("://") === -1 ? "https://" + raw : raw
    return ctx.host.http.normalizeHttpsBaseUrl(withScheme)
  }

  function requestJson(ctx, opts) {
    let resp
    try {
      resp = ctx.util.request(opts)
    } catch (e) {
      ctx.host.log.error("request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }
    if (ctx.util.isAuthStatus(resp.status)) {
      throw "AUTH"
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }
    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || typeof data !== "object") {
      throw "Usage response invalid. Try again later."
    }
    return data
  }

  function tryRequestJson(ctx, opts) {
    try {
      return { ok: true, data: requestJson(ctx, opts) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  function money(value) {
    return "$" + ((readNumber(value) || 0).toFixed(2))
  }

  function headers(ctx, apiKey) {
    const h = {
      Authorization: "Bearer " + apiKey,
      Accept: "application/json",
    }
    const referer = getEnv(ctx, "OPENROUTER_HTTP_REFERER")
    const title = getEnv(ctx, "OPENROUTER_X_TITLE")
    if (referer) h["HTTP-Referer"] = referer
    if (title) h["X-Title"] = title
    return h
  }

  function pushCreditsLine(ctx, lines, credits) {
    const total = readNumber(credits && credits.total_credits)
    const usage = readNumber(credits && credits.total_usage)
    if (total !== null && total > 0 && usage !== null) {
      lines.push(ctx.line.progress({
        label: "Credits",
        used: usage,
        limit: total,
        format: { kind: "dollars" },
      }))
      lines.push(ctx.line.text({ label: "Balance", value: money(Math.max(0, total - usage)) }))
    }
  }

  function pushKeyLines(ctx, lines, key) {
    const limit = readNumber(key && key.limit)
    const usage = readNumber(key && key.usage)
    if (limit !== null && limit > 0 && usage !== null) {
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

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "No OpenRouter API key found. Add it in Settings or set OPENROUTER_API_KEY."
    }
    const apiUrl = normalizeApiUrl(ctx, getConfig(ctx, "apiUrl") || getEnv(ctx, "OPENROUTER_API_URL"))
    if (!apiUrl) {
      throw "OpenRouter API URL must be a valid HTTPS base URL without embedded credentials."
    }

    const requestHeaders = headers(ctx, apiKey)
    const creditsResult = tryRequestJson(ctx, {
      method: "GET",
      url: apiUrl + "/credits",
      headers: requestHeaders,
      timeoutMs: 15000,
    })
    const keyResult = tryRequestJson(ctx, {
      method: "GET",
      url: apiUrl + "/key",
      headers: requestHeaders,
      timeoutMs: 15000,
    })

    if (!creditsResult.ok && !keyResult.ok) {
      if (creditsResult.error === "AUTH" || keyResult.error === "AUTH") {
        throw "OpenRouter API key invalid. Check your OpenRouter API key."
      }
      throw creditsResult.error || keyResult.error
    }

    const lines = []
    if (creditsResult.ok) pushCreditsLine(ctx, lines, creditsResult.data && creditsResult.data.data)
    if (keyResult.ok) pushKeyLines(ctx, lines, keyResult.data && keyResult.data.data)
    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    return { plan: keyResult.ok && keyResult.data && keyResult.data.data && keyResult.data.data.is_free_tier ? "Free Tier" : null, lines }
  }

  globalThis.__openusage_plugin = { id: "openrouter", probe }
})()
