(function () {
  const REGIONS = {
    intl: {
      gateway: "https://modelstudio.console.alibabacloud.com",
      consoleRpc: "https://bailian-singapore-cs.alibabacloud.com",
      dashboard: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan",
      referer: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan",
      action: "IntlBroadScopeAspnGateway",
      currentRegionId: "ap-southeast-1",
      commodityCode: "sfm_codingplan_public_intl",
    },
    cn: {
      gateway: "https://bailian.console.aliyun.com",
      consoleRpc: "https://bailian-cs.console.aliyun.com",
      dashboard: "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan",
      referer: "https://bailian.console.aliyun.com/cn-beijing/?tab=model",
      action: "BroadScopeAspnGateway",
      currentRegionId: "cn-beijing",
      commodityCode: "sfm_codingplan_public_cn",
    },
  }
  const QUERY_API = "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2"
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000
  const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

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

  function region(ctx) {
    const raw = getConfig(ctx, "region") || "intl"
    return REGIONS[raw] || REGIONS.intl
  }

  function source(ctx) {
    const raw = getConfig(ctx, "source") || "auto"
    if (raw === "api-key" || raw === "manual-cookie") return raw
    return "auto"
  }

  function apiKey(ctx) {
    return getConfig(ctx, "apiKey") ||
      getEnv(ctx, "ALIBABA_CODING_PLAN_API_KEY") ||
      getEnv(ctx, "ALIBABA_QWEN_API_KEY") ||
      getEnv(ctx, "DASHSCOPE_API_KEY")
  }

  function cookieHeader(ctx) {
    return normalizeCookieHeader(getConfig(ctx, "cookieHeader") || getEnv(ctx, "ALIBABA_CODING_PLAN_COOKIE"))
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

  function apiUrl(r) {
    return r.gateway + "/data/api.json?action=" + encodeURIComponent(QUERY_API) +
      "&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=" +
      encodeURIComponent(r.currentRegionId)
  }

  function consoleUrl(r) {
    return r.consoleRpc + "/data/api.json?action=" + encodeURIComponent(r.action) +
      "&product=sfm_bailian&api=" + encodeURIComponent(QUERY_API) + "&_v=undefined"
  }

  function requestJson(ctx, opts, authMessage) {
    let resp
    try {
      resp = ctx.util.request(opts)
    } catch (e) {
      ctx.host.log.error("request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }
    if (ctx.util.isAuthStatus(resp.status)) throw authMessage
    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }
    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || typeof data !== "object") throw "Usage response invalid. Try again later."
    return expandJson(data)
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

  function fetchApi(ctx, r, key) {
    return requestJson(ctx, {
      method: "POST",
      url: apiUrl(r),
      headers: {
        Authorization: "Bearer " + key,
        "x-api-key": key,
        "X-DashScope-API-Key": key,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: r.gateway,
        Referer: r.dashboard,
        "User-Agent": USER_AGENT,
      },
      bodyText: JSON.stringify({
        queryCodingPlanInstanceInfoRequest: { commodityCode: r.commodityCode },
      }),
      timeoutMs: 15000,
    }, "Alibaba Coding Plan API key invalid. Check your API key.")
  }

  function fetchCookie(ctx, r, cookie) {
    const secToken = extractCookieValue("sec_token", cookie)
    if (!secToken) {
      throw "Alibaba Coding Plan cookie missing sec_token. Copy a fresh console Cookie header."
    }
    const anonymousId = extractCookieValue("cna", cookie)
    const cornerstoneParam = {
      feTraceId: "openusagecn",
      feURL: r.dashboard,
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      domain: r.gateway.replace(/^https:\/\//, ""),
      consoleSite: r.currentRegionId === "cn-beijing" ? "BAILIAN_ALIYUN" : "MODELSTUDIO_ALIBABACLOUD",
      userNickName: "",
      userPrincipalName: "",
      xsp_lang: "en-US",
    }
    if (anonymousId) cornerstoneParam["X-Anonymous-Id"] = anonymousId
    const params = {
      Api: QUERY_API,
      V: "1.0",
      Data: {
        queryCodingPlanInstanceInfoRequest: {
          commodityCode: r.commodityCode,
          onlyLatestOne: true,
        },
        cornerstoneParam,
      },
    }
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      Cookie: cookie,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": USER_AGENT,
      Origin: r.gateway,
      Referer: r.referer,
    }
    const csrf = extractCookieValue("login_aliyunid_csrf", cookie) || extractCookieValue("csrf", cookie)
    if (csrf) {
      headers["x-xsrf-token"] = csrf
      headers["x-csrf-token"] = csrf
    }
    return requestJson(ctx, {
      method: "POST",
      url: consoleUrl(r),
      headers,
      bodyText: formEncode({
        params: JSON.stringify(params),
        region: r.currentRegionId,
        sec_token: secToken,
      }),
      timeoutMs: 15000,
    }, "Alibaba Coding Plan login expired. Copy a fresh console Cookie header.")
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

  function firstString(value, keys) {
    const object = findObjectWithKeys(value, keys)
    if (!object) return null
    for (let i = 0; i < keys.length; i += 1) {
      const text = readString(object[keys[i]])
      if (text) return text
    }
    return null
  }

  function quotaLine(ctx, label, quota, usedKeys, totalKeys, resetKeys, durationMs) {
    let used = null
    let total = null
    for (let i = 0; i < usedKeys.length; i += 1) if (used === null) used = readNumber(quota[usedKeys[i]])
    for (let i = 0; i < totalKeys.length; i += 1) if (total === null) total = readNumber(quota[totalKeys[i]])
    if (used === null || total === null || total <= 0) return null
    const percent = Math.round(Math.max(0, Math.min(100, used / total * 100)) * 10) / 10
    const opts = {
      label,
      used: percent,
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: durationMs,
    }
    for (let i = 0; i < resetKeys.length; i += 1) {
      const resetsAt = ctx.util.toIso(quota[resetKeys[i]])
      if (resetsAt) {
        opts.resetsAt = resetsAt
        break
      }
    }
    return ctx.line.progress(opts)
  }

  function parseUsage(ctx, payload) {
    const quota = findObjectWithKeys(payload, [
      "codingPlanQuotaInfo",
      "per5HourUsedQuota",
      "perWeekUsedQuota",
      "perBillMonthUsedQuota",
    ])
    const info = quota && quota.codingPlanQuotaInfo ? quota.codingPlanQuotaInfo : quota
    if (!info) throw "Alibaba Coding Plan response missing quota data."

    const lines = []
    const session = quotaLine(ctx, "Session", info,
      ["per5HourUsedQuota", "per_5_hour_used_quota"],
      ["per5HourTotalQuota", "per_5_hour_total_quota"],
      ["per5HourQuotaNextRefreshTime", "per_5_hour_quota_next_refresh_time"],
      FIVE_HOURS_MS)
    const weekly = quotaLine(ctx, "Weekly", info,
      ["perWeekUsedQuota", "per_week_used_quota"],
      ["perWeekTotalQuota", "per_week_total_quota"],
      ["perWeekQuotaNextRefreshTime", "per_week_quota_next_refresh_time"],
      WEEK_MS)
    const monthly = quotaLine(ctx, "Monthly", info,
      ["perBillMonthUsedQuota", "per_bill_month_used_quota"],
      ["perBillMonthTotalQuota", "per_bill_month_total_quota"],
      ["perBillMonthQuotaNextRefreshTime", "per_bill_month_quota_next_refresh_time"],
      MONTH_MS)
    if (session) lines.push(session)
    if (weekly) lines.push(weekly)
    if (monthly) lines.push(monthly)
    if (lines.length === 0) throw "Alibaba Coding Plan response missing quota totals."

    const plan = firstString(payload, ["planName", "instanceName", "packageName", "productName"])
    return { plan: plan ? ctx.fmt.planLabel(plan) : null, lines }
  }

  function probe(ctx) {
    const r = region(ctx)
    const mode = source(ctx)
    const key = apiKey(ctx)
    const cookie = cookieHeader(ctx)

    if ((mode === "api-key" || mode === "auto") && key) {
      return parseUsage(ctx, fetchApi(ctx, r, key))
    }
    if ((mode === "manual-cookie" || mode === "auto") && cookie) {
      return parseUsage(ctx, fetchCookie(ctx, r, cookie))
    }
    if (mode === "manual-cookie") {
      throw "No Alibaba Coding Plan cookie found. Add it in Settings or set ALIBABA_CODING_PLAN_COOKIE."
    }
    throw "No Alibaba Coding Plan API key found. Add it in Settings or set ALIBABA_CODING_PLAN_API_KEY."
  }

  globalThis.__openusage_plugin = { id: "alibaba-coding-plan", probe }
})()
