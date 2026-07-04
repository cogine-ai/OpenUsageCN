(function () {
  const QUOTA_URL = "https://bailian.console.aliyun.com/data/api.json?action=GetSubscriptionSummary&product=BssOpenAPI-V3&_tag="
  const DASHBOARD_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan"
  const TOKEN_PLAN_PRODUCT_CODE = "sfm_tokenplanteams_dp_cn"
  const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000

  const USED_KEYS = ["usedQuota", "used_quota", "usedCredits", "consumedCredits", "usage", "used", "usedAmount", "consumeAmount", "usedValue", "UsedValue", "ConsumedValue"]
  const TOTAL_KEYS = ["totalQuota", "total_quota", "totalCredits", "quota", "creditLimit", "creditsTotal", "monthlyTotalQuota", "amount", "totalValue", "TotalValue"]
  const REMAINING_KEYS = ["remainingQuota", "remainQuota", "remainingCredits", "availableCredits", "balance", "remaining", "availableAmount", "remainAmount", "totalSurplusValue", "TotalSurplusValue", "SurplusValue"]
  const COUNT_KEYS = ["totalCount", "TotalCount", "subscriptionTotalNumber", "SubscriptionTotalNumber"]
  const RESET_KEYS = ["nextRefreshTime", "resetTime", "periodEndTime", "billingCycleEnd", "expireTime", "expirationTime", "endTime", "validEndTime", "nearestExpireDate", "NearestExpireDate"]
  const PLAN_KEYS = ["planName", "PlanName", "productName", "ProductName", "instanceName", "InstanceName", "packageName", "PackageName"]

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    const cleaned = value.trim().replace(/,/g, "")
    const n = Number(cleaned)
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

  function normalizeCookieHeader(raw) {
    const text = readString(raw)
    if (!text) return null
    return text
      .replace(/^Cookie:\s*/i, "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => /^[^=;\s]+=[^;]+$/.test(part))
      .join("; ") || null
  }

  function cookieHeader(ctx) {
    return normalizeCookieHeader(getConfig(ctx, "cookieHeader") || getEnv(ctx, "ALIBABA_TOKEN_PLAN_COOKIE"))
  }

  function extractCookieValue(name, cookie) {
    const parts = String(cookie || "").split(";")
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i].trim()
      const eq = part.indexOf("=")
      if (eq <= 0) continue
      if (part.slice(0, eq) === name) return part.slice(eq + 1)
    }
    return null
  }

  function formEncode(values) {
    return Object.keys(values).map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(String(values[key]))).join("&")
  }

  function expandJson(value) {
    if (typeof value === "string") {
      const trimmed = value.trim()
      if ((trimmed[0] === "{" || trimmed[0] === "[") && trimmed.length > 1) {
        try {
          return expandJson(JSON.parse(trimmed))
        } catch (e) {
          return value
        }
      }
      return value
    }
    if (Array.isArray(value)) return value.map((item) => expandJson(item))
    if (value && typeof value === "object") {
      const out = {}
      const keys = Object.keys(value)
      for (let i = 0; i < keys.length; i += 1) out[keys[i]] = expandJson(value[keys[i]])
      return out
    }
    return value
  }

  function requestSummary(ctx, cookie) {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      Cookie: cookie,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": USER_AGENT,
      Origin: "https://bailian.console.aliyun.com",
      Referer: DASHBOARD_URL,
    }
    const csrf = extractCookieValue("login_aliyunid_csrf", cookie) || extractCookieValue("csrf", cookie)
    if (csrf) {
      headers["x-xsrf-token"] = csrf
      headers["x-csrf-token"] = csrf
    }
    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: QUOTA_URL,
        headers,
        bodyText: formEncode({
          product: "BssOpenAPI-V3",
          action: "GetSubscriptionSummary",
          params: JSON.stringify({ ProductCode: TOKEN_PLAN_PRODUCT_CODE }),
          region: "cn-beijing",
          sec_token: extractCookieValue("sec_token", cookie) || "",
        }),
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }
    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Alibaba Token Plan login expired. Copy a fresh console Cookie header."
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }
    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || typeof data !== "object") throw "Usage response invalid. Try again later."
    return expandJson(data)
  }

  function findObjectWithKeys(value, keys) {
    if (!value || typeof value !== "object") return null
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = findObjectWithKeys(value[i], keys)
        if (found) return found
      }
      return null
    }
    for (let i = 0; i < keys.length; i += 1) {
      if (value[keys[i]] !== undefined) return value
    }
    const objectKeys = Object.keys(value)
    for (let i = 0; i < objectKeys.length; i += 1) {
      const found = findObjectWithKeys(value[objectKeys[i]], keys)
      if (found) return found
    }
    return null
  }

  function anyNumber(object, keys) {
    if (!object) return null
    for (let i = 0; i < keys.length; i += 1) {
      const n = readNumber(object[keys[i]])
      if (n !== null) return n
    }
    return null
  }

  function anyString(object, keys) {
    if (!object) return null
    for (let i = 0; i < keys.length; i += 1) {
      const s = readString(object[keys[i]])
      if (s) return s
    }
    return null
  }

  function compactCount(value) {
    const n = readNumber(value) || 0
    if (n >= 1000000000) return Math.round((n / 1000000000) * 10) / 10 + "B"
    if (n >= 1000000) return Math.round((n / 1000000) * 10) / 10 + "M"
    if (n >= 1000) return Math.round((n / 1000) * 10) / 10 + "K"
    return String(Math.round(n * 100) / 100)
  }

  function parseUsage(ctx, payload) {
    const summary = findObjectWithKeys(payload, USED_KEYS.concat(TOTAL_KEYS, REMAINING_KEYS, COUNT_KEYS))
    if (!summary) throw "Alibaba Token Plan response missing quota data."

    const total = anyNumber(summary, TOTAL_KEYS)
    const remaining = anyNumber(summary, REMAINING_KEYS)
    let used = anyNumber(summary, USED_KEYS)
    if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining)
    const totalCount = anyNumber(summary, COUNT_KEYS)
    const planName = anyString(summary, PLAN_KEYS) || (totalCount !== null ? "Token Plan" : null)
    const reset = anyString(summary, RESET_KEYS)

    const lines = []
    if (total !== null && total > 0 && used !== null) {
      const opts = {
        label: "Token Quota",
        used,
        limit: total,
        format: { kind: "count", suffix: "tokens" },
        periodDurationMs: MONTH_MS,
      }
      const resetsAt = ctx.util.toIso(reset)
      if (resetsAt) opts.resetsAt = resetsAt
      lines.push(ctx.line.progress(opts))
    }
    if (remaining !== null) {
      lines.push(ctx.line.text({ label: "Remaining", value: compactCount(remaining) }))
    }
    const expiresAt = ctx.util.toIso(reset)
    if (expiresAt) {
      lines.push(ctx.line.text({ label: "Expires", value: expiresAt.slice(0, 10) }))
    }
    if (lines.length === 0) throw "Alibaba Token Plan response missing quota totals."
    return { plan: planName ? ctx.fmt.planLabel(planName) : null, lines }
  }

  function probe(ctx) {
    const cookie = cookieHeader(ctx)
    if (!cookie) {
      throw "No Alibaba Token Plan cookie found. Add it in Settings or set ALIBABA_TOKEN_PLAN_COOKIE."
    }
    return parseUsage(ctx, requestSummary(ctx, cookie))
  }

  globalThis.__openusage_plugin = { id: "alibaba-token-plan", probe }
})()
