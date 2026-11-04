(function () {
  const DEFAULT_API_URL = "https://openrouter.ai/api/v1"

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string" || !value.trim()) return null
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

  function requestJson(ctx, opts, deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw failure("error", "Usage request timed out. Try again later.")
    opts.timeoutMs = Math.max(1, Math.min(opts.timeoutMs || 15000, remaining))
    let resp
    try {
      resp = ctx.util.request(opts)
    } catch (e) {
      ctx.host.log.error("OpenRouter request failed")
      throw failure("error", "Usage request failed. Check your connection.")
    }
    if (!resp || !Number.isFinite(resp.status)) {
      throw failure("error", "Usage response invalid. Try again later.")
    }
    if (ctx.util.isAuthStatus(resp.status)) {
      throw failure(resp.status === 401 ? "authExpired" : "permissionDenied", "OpenRouter API key invalid or missing permission. Check your OpenRouter API key.")
    }
    if (resp.status === 429) throw failure("rateLimited", "OpenRouter is rate limiting requests. Try again later.")
    if (resp.status < 200 || resp.status >= 300) {
      throw failure("error", "Usage request failed (HTTP " + String(resp.status) + "). Try again later.")
    }
    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw failure("error", "Usage response invalid. Try again later.")
    }
    return data
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

  function failure(status, message) {
    const error = new Error(message)
    error.reportStatus = status
    return error
  }

  function settings(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) throw failure("authExpired", "No OpenRouter API key found. Add it in Settings or set OPENROUTER_API_KEY.")
    const apiUrl = normalizeApiUrl(ctx, getConfig(ctx, "apiUrl") || getEnv(ctx, "OPENROUTER_API_URL"))
    if (!apiUrl) throw failure("error", "OpenRouter API URL must be a valid HTTPS base URL without embedded credentials.")
    return { apiKey, apiUrl }
  }

  function get(ctx, config, path, deadline) {
    return requestJson(ctx, { method: "GET", url: config.apiUrl + path,
      headers: headers(ctx, config.apiKey), timeoutMs: 15000 }, deadline)
  }

  function scopeKey(ctx, config, workspace) {
    return ctx.host.crypto.sha256Hex(JSON.stringify(["openrouter", config.apiUrl, config.apiKey, workspace || "account-activity"]))
  }

  globalThis.__openrouterCommon = { readNumber, money, failure, settings, get, scopeKey }
})()
