(function () {
  const BASE_URL = "https://opencode.ai"
  const SERVER_URL = BASE_URL + "/_server"
  const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f"
  const SUBSCRIPTION_SERVER_ID = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4"
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

  const PERCENT_KEYS = ["usagePercent", "usedPercent", "percentUsed", "percent", "usage_percent", "used_percent", "utilization", "utilizationPercent", "usage"]
  const RESET_IN_KEYS = ["resetInSec", "resetInSeconds", "resetSeconds", "reset_sec", "reset_in_sec", "resetsInSec", "resetIn", "resetSec"]
  const RESET_AT_KEYS = ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "next_reset"]
  const RENEW_AT_KEYS = ["renewAt", "renew_at"]

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
    return normalizeCookieHeader(getConfig(ctx, "cookieHeader") || getEnv(ctx, "OPENCODE_COOKIE"))
  }

  function normalizeWorkspaceId(raw) {
    const text = readString(raw)
    if (!text) return null
    if (/^wrk_[A-Za-z0-9]+$/.test(text)) return text
    const urlMatch = text.match(/\/workspace\/(wrk_[A-Za-z0-9]+)/)
    if (urlMatch) return urlMatch[1]
    const anyMatch = text.match(/wrk_[A-Za-z0-9]+/)
    return anyMatch ? anyMatch[0] : null
  }

  function configuredWorkspaceId(ctx) {
    return normalizeWorkspaceId(getConfig(ctx, "workspaceId") || getEnv(ctx, "OPENCODE_WORKSPACE_ID"))
  }

  function nowMs(ctx) {
    return ctx.util.parseDateMs(ctx.nowIso) || Date.now()
  }

  function serverRequestUrl(serverId, args, method) {
    if (String(method).toUpperCase() !== "GET") return SERVER_URL
    let url = SERVER_URL + "?id=" + encodeURIComponent(serverId)
    if (args && args.length) url += "&args=" + encodeURIComponent(JSON.stringify(args))
    return url
  }

  function fetchServerText(ctx, request, cookie) {
    const method = request.method || "GET"
    const headers = {
      Cookie: cookie,
      "X-Server-Id": request.serverId,
      "X-Server-Instance": "server-fn:openusagecn",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: request.referer || BASE_URL,
      Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
    }
    const opts = {
      method,
      url: serverRequestUrl(request.serverId, request.args, method),
      headers,
      timeoutMs: 15000,
    }
    if (method !== "GET" && request.args) {
      opts.bodyText = JSON.stringify(request.args)
      headers["Content-Type"] = "application/json"
    }

    let resp
    try {
      resp = ctx.util.request(opts)
    } catch (e) {
      ctx.host.log.error("request exception: " + String(e))
      throw "OpenCode request failed. Check your connection."
    }

    const text = String(resp.bodyText || "")
    if (looksSignedOut(text) || ctx.util.isAuthStatus(resp.status)) {
      throw "OpenCode session expired. Copy a fresh opencode.ai Cookie header."
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "OpenCode request failed (HTTP " + String(resp.status) + "). Try again later."
    }
    return text
  }

  function looksSignedOut(text) {
    const lower = String(text || "").toLowerCase()
    return lower.indexOf("login") !== -1 ||
      lower.indexOf("sign in") !== -1 ||
      lower.indexOf("auth/authorize") !== -1 ||
      lower.indexOf("not associated with an account") !== -1 ||
      lower.indexOf('actor of type "public"') !== -1
  }

  function parseWorkspaceIds(text) {
    const ids = []
    const regex = /id\s*:\s*["'](wrk_[^"']+)["']/g
    let match = regex.exec(text)
    while (match) {
      if (ids.indexOf(match[1]) === -1) ids.push(match[1])
      match = regex.exec(text)
    }
    const json = tryJson(text)
    collectWorkspaceIds(json, ids)
    return ids
  }

  function collectWorkspaceIds(value, ids) {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) collectWorkspaceIds(value[i], ids)
      return
    }
    const keys = Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) {
      const item = value[keys[i]]
      if (typeof item === "string" && /^wrk_[A-Za-z0-9]+$/.test(item) && ids.indexOf(item) === -1) {
        ids.push(item)
      } else {
        collectWorkspaceIds(item, ids)
      }
    }
  }

  function fetchWorkspaceId(ctx, cookie) {
    const text = fetchServerText(ctx, {
      serverId: WORKSPACES_SERVER_ID,
      method: "GET",
      referer: BASE_URL,
    }, cookie)
    let ids = parseWorkspaceIds(text)
    if (ids.length > 0) return ids[0]

    const fallback = fetchServerText(ctx, {
      serverId: WORKSPACES_SERVER_ID,
      method: "POST",
      args: [],
      referer: BASE_URL,
    }, cookie)
    ids = parseWorkspaceIds(fallback)
    if (ids.length > 0) return ids[0]
    throw "OpenCode workspace ID not found. Add the Workspace ID in Settings."
  }

  function fetchSubscription(ctx, cookie, workspaceId) {
    const referer = BASE_URL + "/workspace/" + workspaceId + "/billing"
    const text = fetchServerText(ctx, {
      serverId: SUBSCRIPTION_SERVER_ID,
      method: "GET",
      args: [workspaceId],
      referer,
    }, cookie)
    if (hasUsageShape(text)) return text

    const fallback = fetchServerText(ctx, {
      serverId: SUBSCRIPTION_SERVER_ID,
      method: "POST",
      args: [workspaceId],
      referer,
    }, cookie)
    return fallback
  }

  function hasUsageShape(text) {
    return /rollingUsage|weeklyUsage|usagePercent|resetInSec/.test(String(text || ""))
  }

  function tryJson(text) {
    return ctxlessJson(text)
  }

  function ctxlessJson(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed)
    } catch (e) {
      return null
    }
  }

  function anyNumber(object, keys) {
    if (!object || typeof object !== "object") return null
    for (let i = 0; i < keys.length; i += 1) {
      const n = readNumber(object[keys[i]])
      if (n !== null) return n
    }
    return null
  }

  function anyString(object, keys) {
    if (!object || typeof object !== "object") return null
    for (let i = 0; i < keys.length; i += 1) {
      const s = readString(object[keys[i]])
      if (s) return s
    }
    return null
  }

  function findUsagePair(value) {
    if (!value || typeof value !== "object") return null
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = findUsagePair(value[i])
        if (found) return found
      }
      return null
    }
    if (value.rollingUsage || value.weeklyUsage) {
      return { rolling: value.rollingUsage || null, weekly: value.weeklyUsage || null, renewAt: anyString(value, RENEW_AT_KEYS) }
    }
    const keys = Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) {
      const found = findUsagePair(value[keys[i]])
      if (found) return found
    }
    return null
  }

  function parseUsageWindow(window, now) {
    if (!window || typeof window !== "object") return null
    let percent = anyNumber(window, PERCENT_KEYS)
    if (percent === null) {
      const used = anyNumber(window, ["used", "current", "currentValue"])
      const limit = anyNumber(window, ["limit", "total", "totalValue"])
      if (used !== null && limit !== null && limit > 0) percent = used / limit * 100
    }
    if (percent === null) return null
    if (percent <= 1) percent *= 100
    percent = Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10

    let resetIn = anyNumber(window, RESET_IN_KEYS)
    let resetsAt = null
    if (resetIn !== null) {
      resetsAt = new Date(now + resetIn * 1000).toISOString()
    } else {
      resetsAt = toIso(anyString(window, RESET_AT_KEYS))
    }
    return { percent, resetsAt }
  }

  function toIso(value) {
    if (!value) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }

  function parseRegexUsage(text, now) {
    const rollingPercent = extractNumber(/rollingUsage[^}]*?usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)/, text)
    const rollingReset = extractNumber(/rollingUsage[^}]*?resetInSec\s*:\s*([0-9]+)/, text)
    const weeklyPercent = extractNumber(/weeklyUsage[^}]*?usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)/, text)
    const weeklyReset = extractNumber(/weeklyUsage[^}]*?resetInSec\s*:\s*([0-9]+)/, text)
    if (rollingPercent === null && weeklyPercent === null) return null
    return {
      rolling: rollingPercent === null ? null : {
        percent: Math.max(0, Math.min(100, rollingPercent)),
        resetsAt: rollingReset === null ? null : new Date(now + rollingReset * 1000).toISOString(),
      },
      weekly: weeklyPercent === null ? null : {
        percent: Math.max(0, Math.min(100, weeklyPercent)),
        resetsAt: weeklyReset === null ? null : new Date(now + weeklyReset * 1000).toISOString(),
      },
      renewAt: null,
    }
  }

  function extractNumber(regex, text) {
    const match = String(text || "").match(regex)
    return match ? readNumber(match[1]) : null
  }

  function parseSubscription(ctx, text) {
    const now = nowMs(ctx)
    let parsed = null
    const json = tryJson(text)
    const pair = findUsagePair(json)
    if (pair) {
      parsed = {
        rolling: parseUsageWindow(pair.rolling, now),
        weekly: parseUsageWindow(pair.weekly, now),
        renewAt: pair.renewAt,
      }
    }
    if (!parsed || (!parsed.rolling && !parsed.weekly)) {
      parsed = parseRegexUsage(text, now)
    }
    if (!parsed || (!parsed.rolling && !parsed.weekly)) {
      throw "OpenCode response missing subscription usage fields."
    }

    const lines = []
    if (parsed.rolling) {
      const opts = {
        label: "Session",
        used: parsed.rolling.percent,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: FIVE_HOURS_MS,
      }
      if (parsed.rolling.resetsAt) opts.resetsAt = parsed.rolling.resetsAt
      lines.push(ctx.line.progress(opts))
    }
    if (parsed.weekly) {
      const opts = {
        label: "Weekly",
        used: parsed.weekly.percent,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: WEEK_MS,
      }
      if (parsed.weekly.resetsAt) opts.resetsAt = parsed.weekly.resetsAt
      lines.push(ctx.line.progress(opts))
    }
    const renewsAt = toIso(parsed.renewAt)
    if (renewsAt) lines.push(ctx.line.text({ label: "Renews", value: renewsAt.slice(0, 10) }))
    return { plan: null, lines }
  }

  function probe(ctx) {
    const cookie = cookieHeader(ctx)
    if (!cookie) {
      throw "No OpenCode cookie found. Add it in Settings or set OPENCODE_COOKIE."
    }
    const workspaceId = configuredWorkspaceId(ctx) || fetchWorkspaceId(ctx, cookie)
    const text = fetchSubscription(ctx, cookie, workspaceId)
    return parseSubscription(ctx, text)
  }

  globalThis.__openusage_plugin = { id: "opencode", probe }
})()
