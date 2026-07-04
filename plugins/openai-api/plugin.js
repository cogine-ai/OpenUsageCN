(function () {
  const BASE_URL = "https://api.openai.com"
  const ADMIN_COSTS_URL = BASE_URL + "/v1/organization/costs"
  const ADMIN_USAGE_URL = BASE_URL + "/v1/organization/usage/completions"
  const LEGACY_CREDITS_URL = BASE_URL + "/v1/dashboard/billing/credit_grants"
  const DAY_MS = 24 * 60 * 60 * 1000

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
    return getConfig(ctx, "apiKey") || getEnv(ctx, "OPENAI_ADMIN_KEY") || getEnv(ctx, "OPENAI_API_KEY")
  }

  function loadProjectId(ctx) {
    return getConfig(ctx, "projectId") || getEnv(ctx, "OPENAI_PROJECT_ID")
  }

  function buildUrl(base, params) {
    const parts = []
    const keys = Object.keys(params || {})
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      const value = params[key]
      if (value === null || value === undefined || value === "") continue
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
    }
    return parts.length ? base + "?" + parts.join("&") : base
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

  function nowMs(ctx) {
    const parsed = ctx.util.parseDateMs(ctx.nowIso)
    return parsed || Date.now()
  }

  function sumBucketResults(page, read) {
    let total = 0
    const buckets = Array.isArray(page && page.data) ? page.data : []
    for (let i = 0; i < buckets.length; i += 1) {
      const results = Array.isArray(buckets[i].results) ? buckets[i].results : []
      for (let j = 0; j < results.length; j += 1) {
        total += read(results[j])
      }
    }
    return Math.round(total * 100) / 100
  }

  function compactCount(value) {
    const n = readNumber(value) || 0
    if (n >= 1000000) return Math.round((n / 1000000) * 10) / 10 + "M"
    if (n >= 1000) return Math.round((n / 1000) * 10) / 10 + "K"
    return String(Math.round(n))
  }

  function money(value, currency) {
    const n = readNumber(value) || 0
    const prefix = !currency || String(currency).toLowerCase() === "usd" ? "$" : String(currency).toUpperCase() + " "
    return prefix + n.toFixed(2)
  }

  function fetchAdminUsage(ctx, apiKey, projectId) {
    const endSec = Math.floor(nowMs(ctx) / 1000)
    const startSec = Math.floor((nowMs(ctx) - 7 * DAY_MS) / 1000)
    const common = {
      start_time: startSec,
      end_time: endSec,
      bucket_width: "1d",
      limit: 31,
    }
    if (projectId) common.project_ids = projectId

    const headers = {
      Authorization: "Bearer " + apiKey,
      Accept: "application/json",
    }

    const costs = requestJson(ctx, {
      method: "GET",
      url: buildUrl(ADMIN_COSTS_URL, Object.assign({}, common, { group_by: "line_item" })),
      headers,
      timeoutMs: 15000,
    })

    const usage = requestJson(ctx, {
      method: "GET",
      url: buildUrl(ADMIN_USAGE_URL, Object.assign({}, common, { group_by: "model" })),
      headers,
      timeoutMs: 15000,
    })

    const spend = sumBucketResults(costs, (item) => readNumber(item && item.amount && item.amount.value) || 0)
    const currency = findCurrency(costs) || "usd"
    const requests = sumBucketResults(usage, (item) => readNumber(item && item.num_model_requests) || 0)
    const input = sumBucketResults(usage, (item) => readNumber(item && item.input_tokens) || 0)
    const cached = sumBucketResults(usage, (item) => readNumber(item && item.input_cached_tokens) || 0)
    const output = sumBucketResults(usage, (item) => readNumber(item && item.output_tokens) || 0)

    const lines = [
      ctx.line.text({ label: "7D Spend", value: money(spend, currency) }),
      ctx.line.text({ label: "Requests", value: compactCount(requests) }),
      ctx.line.text({ label: "Tokens", value: compactCount(input + output), subtitle: "Input " + compactCount(input) + " / Output " + compactCount(output) }),
    ]
    if (cached > 0) {
      lines.push(ctx.line.text({ label: "Cached Tokens", value: compactCount(cached) }))
    }

    return { plan: projectId ? "Admin API Project" : "Admin API", lines }
  }

  function findCurrency(page) {
    const buckets = Array.isArray(page && page.data) ? page.data : []
    for (let i = 0; i < buckets.length; i += 1) {
      const results = Array.isArray(buckets[i].results) ? buckets[i].results : []
      for (let j = 0; j < results.length; j += 1) {
        const currency = readString(results[j] && results[j].amount && results[j].amount.currency)
        if (currency) return currency
      }
    }
    return null
  }

  function fetchLegacyCredits(ctx, apiKey) {
    const data = requestJson(ctx, {
      method: "GET",
      url: LEGACY_CREDITS_URL,
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      timeoutMs: 15000,
    })
    const total = readNumber(data.total_granted) || 0
    const used = readNumber(data.total_used) || 0
    const remaining = readNumber(data.total_available) || Math.max(0, total - used)
    const lines = []
    if (total > 0) {
      lines.push(ctx.line.progress({
        label: "Credits",
        used,
        limit: total,
        format: { kind: "dollars" },
      }))
    }
    lines.push(ctx.line.text({ label: "Balance", value: money(remaining, "usd") }))
    return { plan: "Legacy API Key", lines }
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "No OpenAI API key found. Add an Admin API key in Settings or set OPENAI_ADMIN_KEY."
    }
    const projectId = loadProjectId(ctx)

    try {
      return fetchAdminUsage(ctx, apiKey, projectId)
    } catch (e) {
      if (String(e) !== "AUTH") throw e
      if (projectId) {
        throw "OpenAI Admin API key invalid or lacks organization usage access."
      }
    }

    try {
      return fetchLegacyCredits(ctx, apiKey)
    } catch (e) {
      if (String(e) === "AUTH") {
        throw "OpenAI API key invalid. Check your OpenAI API key."
      }
      throw e
    }
  }

  globalThis.__openusage_plugin = { id: "openai-api", probe }
})()
