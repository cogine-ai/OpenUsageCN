(function () {
  const BASE_URL = "https://api.z.ai"
  const SUBSCRIPTION_URL = BASE_URL + "/api/biz/subscription/list"
  const QUOTA_URL = BASE_URL + "/api/monitor/usage/quota/limit"
  const PERIOD_MS = 5 * 60 * 60 * 1000
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000

  function loadApiKey(ctx) {
    const configured = ctx.host.config && ctx.host.config.get
      ? ctx.host.config.get("apiKey")
      : null
    if (typeof configured === "string" && configured.trim()) return configured.trim()

    const zai = ctx.host.env.get("ZAI_API_KEY")
    if (typeof zai === "string" && zai.trim()) return zai.trim()

    const glm = ctx.host.env.get("GLM_API_KEY")
    if (typeof glm === "string" && glm.trim()) return glm.trim()

    return null
  }

  function fetchSubscription(ctx, apiKey) {
    try {
      const resp = ctx.util.request({
        method: "GET",
        url: SUBSCRIPTION_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("subscription request failed: HTTP " + resp.status)
        return null
      }
      const data = ctx.util.tryParseJson(resp.bodyText)
      if (!data) return null
      const list = data.data
      if (!Array.isArray(list) || list.length === 0) return null
      return {
        productName: list[0].productName || null,
        nextRenewTime: list[0].nextRenewTime || null,
      }
    } catch (e) {
      ctx.host.log.warn("subscription request exception: " + String(e))
      return null
    }
  }

  function fetchQuota(ctx, apiKey) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: QUOTA_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.error("usage request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "API key invalid. Check your Z.ai API key."
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data) {
      throw "Usage response invalid. Try again later."
    }

    return data
  }

  function quotaWindowMs(item) {
    const units = { 1: 86400000, 3: 3600000, 5: 60000, 6: WEEK_MS }
    if (!Number.isInteger(item.unit) || !Number.isInteger(item.number) || item.number <= 0) return null
    const duration = units[item.unit] * item.number
    return Number.isSafeInteger(duration) ? duration : null
  }

  function findLimit(limits, type, durationMs) {
    for (let i = 0; i < limits.length; i++) {
      const item = limits[i]
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const kind = item.type || item.name
      if (kind === type || (type === "TOKENS_LIMIT" && kind === "CREDIT_LIMIT")) {
        if (durationMs === undefined || quotaWindowMs(item) === durationMs) {
          return item
        }
      }
    }
    return null
  }

  function resetTimeIso(ctx, item) {
    const value = item.nextResetTime
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) {
      ctx.host.log.error("Quota reset time is not a valid epoch-millisecond timestamp")
      return undefined
    }
    return new Date(value).toISOString()
  }

  function pushProgress(ctx, lines, options) {
    const invalidCount = options.format.kind === "count" && (!Number.isSafeInteger(options.used) || !Number.isSafeInteger(options.limit))
    if (invalidCount || !Number.isFinite(options.used) || options.used < 0 || !Number.isFinite(options.limit) || options.limit <= 0) {
      ctx.host.log.error(options.label + " quota contains missing or invalid numeric values")
      lines.push(ctx.line.badge({ label: options.label, text: "Usage unavailable", color: "#f59e0b" }))
      return
    }
    lines.push(ctx.line.progress(options))
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "No Z.ai API key found. Add it in Settings or set ZAI_API_KEY/GLM_API_KEY."
    }

    const sub = fetchSubscription(ctx, apiKey)
    const plan = sub && sub.productName ? ctx.fmt.planLabel(sub.productName) : null

    const quota = fetchQuota(ctx, apiKey)
    const lines = []

    const container = quota.data || quota
    const limits = Array.isArray(container) ? container : container.limits
    if (!Array.isArray(limits)) {
      ctx.host.log.error("Quota response limits is not an array")
      throw "Quota data is incomplete or invalid. Try again later."
    }
    if (limits.length === 0) {
      lines.push(ctx.line.badge({ label: "Session", text: "No usage data", color: "#a3a3a3" }))
      return { plan, lines }
    }

    const tokenLimit = findLimit(limits, "TOKENS_LIMIT", PERIOD_MS)

    if (tokenLimit) {
      const used = tokenLimit.percentage
      const resetsAt = resetTimeIso(ctx, tokenLimit)
      const progressOpts = {
        label: "Session",
        used,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: PERIOD_MS,
      }
      if (resetsAt) {
        progressOpts.resetsAt = resetsAt
      }
      pushProgress(ctx, lines, progressOpts)
    }

    const weeklyTokenLimit = findLimit(limits, "TOKENS_LIMIT", WEEK_MS)
    if (weeklyTokenLimit) {
      const weeklyUsed = weeklyTokenLimit.percentage
      const weeklyResetsAt = resetTimeIso(ctx, weeklyTokenLimit)

      const weeklyOpts = {
        label: "Weekly",
        used: weeklyUsed,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: WEEK_MS,
      }
      if (weeklyResetsAt) {
        weeklyOpts.resetsAt = weeklyResetsAt
      }
      pushProgress(ctx, lines, weeklyOpts)
    }

    const timeLimit = findLimit(limits, "TIME_LIMIT")

    if (timeLimit) {
      const webUsed = timeLimit.currentValue
      const webTotal = timeLimit.usage
      const webResetsAt = resetTimeIso(ctx, timeLimit)
      // TIME_LIMIT unit 5 / number 1 is a monthly marker, not a one-minute window.
      const webPeriodMs = timeLimit.unit === 5 && timeLimit.number === 1 ? null : quotaWindowMs(timeLimit)

      const webOpts = {
        label: "Web Searches",
        used: webUsed,
        limit: webTotal,
        format: { kind: "count", suffix: "/ " + webTotal },
      }
      if (webPeriodMs) webOpts.periodDurationMs = webPeriodMs
      if (webResetsAt) {
        webOpts.resetsAt = webResetsAt
      }
      pushProgress(ctx, lines, webOpts)
    }

    if (limits.some((item) => !item || (item !== tokenLimit && item !== weeklyTokenLimit && item !== timeLimit))) {
      ctx.host.log.error("Quota response includes unsupported or malformed limits")
      lines.push(ctx.line.badge({ label: "Quota", text: "Some usage unavailable", color: "#f59e0b" }))
    }
    if (!lines.some((line) => line.type === "progress")) {
      ctx.host.log.error("Quota response has no supported, valid usage limits")
      throw "Quota data is incomplete or invalid. Try again later."
    }
    return { plan, lines }
  }

  globalThis.__openusage_plugin = { id: "zai", probe }
})()
