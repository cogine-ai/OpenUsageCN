(function () {
  const AUTH_PATH = "~/.codex/auth.json"
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  const REFRESH_URL = "https://auth.openai.com/oauth/token"
  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
  const REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000

  function lineText(label, value, color) {
    const line = { type: "text", label, value }
    if (color) line.color = color
    return line
  }

  function lineProgress(label, value, max, unit, color) {
    const line = { type: "progress", label, value, max }
    if (unit) line.unit = unit
    if (color) line.color = color
    return line
  }

  function lineBadge(label, text, color) {
    const line = { type: "badge", label, text }
    if (color) line.color = color
    return line
  }

  function formatPlanLabel(value) {
    const text = String(value || "").trim()
    if (!text) return ""
    return text.replace(/(^|\s)([a-z])/g, function (match, space, letter) {
      return space + letter.toUpperCase()
    })
  }

  function loadAuth(ctx) {
    if (!ctx.host.fs.exists(AUTH_PATH)) return null
    try {
      const text = ctx.host.fs.readText(AUTH_PATH)
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function needsRefresh(auth, nowMs) {
    if (!auth.last_refresh) return true
    try {
      const lastMs = new Date(auth.last_refresh).getTime()
      if (!Number.isFinite(lastMs)) return true
      return nowMs - lastMs > REFRESH_AGE_MS
    } catch {
      return true
    }
  }

  function refreshToken(ctx, auth) {
    if (!auth.tokens || !auth.tokens.refresh_token) return null

    try {
      const resp = ctx.host.http.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" + encodeURIComponent(CLIENT_ID) +
          "&refresh_token=" + encodeURIComponent(auth.tokens.refresh_token),
        timeoutMs: 15000,
      })

      if (resp.status < 200 || resp.status >= 300) {
        return null
      }

      const body = JSON.parse(resp.bodyText)
      const newAccessToken = body.access_token
      if (!newAccessToken) return null

      auth.tokens.access_token = newAccessToken
      if (body.refresh_token) auth.tokens.refresh_token = body.refresh_token
      if (body.id_token) auth.tokens.id_token = body.id_token
      auth.last_refresh = new Date().toISOString()

      try {
        ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(auth, null, 2))
      } catch {}

      return newAccessToken
    } catch {
      return null
    }
  }

  function fetchUsage(ctx, accessToken, accountId) {
    const headers = {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "User-Agent": "OpenUsage",
    }
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId
    }
    return ctx.host.http.request({
      method: "GET",
      url: USAGE_URL,
      headers,
      timeoutMs: 10000,
    })
  }

  function readPercent(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function readNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function formatResetIn(secondsUntil) {
    if (!Number.isFinite(secondsUntil) || secondsUntil < 0) return null
    const totalMinutes = Math.floor(secondsUntil / 60)
    const totalHours = Math.floor(totalMinutes / 60)
    const days = Math.floor(totalHours / 24)
    const hours = totalHours % 24
    const minutes = totalMinutes % 60

    if (days > 0) return `${days}d ${hours}h`
    if (totalHours > 0) return `${totalHours}h ${minutes}m`
    if (totalMinutes > 0) return `${totalMinutes}m`
    return "<1m"
  }

  function getResetIn(nowSec, window) {
    if (!window) return null
    if (typeof window.reset_at === "number") {
      return formatResetIn(window.reset_at - nowSec)
    }
    if (typeof window.reset_after_seconds === "number") {
      return formatResetIn(window.reset_after_seconds)
    }
    return null
  }

  function probe(ctx) {
    const auth = loadAuth(ctx)
    if (!auth) {
      return { lines: [lineBadge("Error", "Login required", "#ef4444")] }
    }

    if (auth.tokens && auth.tokens.access_token) {
      const nowMs = Date.now()
      let accessToken = auth.tokens.access_token
      const accountId = auth.tokens.account_id

      if (needsRefresh(auth, nowMs)) {
        const refreshed = refreshToken(ctx, auth)
        if (refreshed) accessToken = refreshed
      }

      let resp
      try {
        resp = fetchUsage(ctx, accessToken, accountId)
      } catch {
        return { lines: [lineBadge("Error", "usage request failed", "#ef4444")] }
      }

      if (resp.status === 401 || resp.status === 403) {
        const refreshed = refreshToken(ctx, auth)
        if (!refreshed) {
          return { lines: [lineBadge("Error", "Token expired", "#ef4444")] }
        }
        try {
          resp = fetchUsage(ctx, refreshed, accountId)
        } catch {
          return { lines: [lineBadge("Error", "usage request after refresh failed", "#ef4444")] }
        }
        if (resp.status === 401 || resp.status === 403) {
          return { lines: [lineBadge("Error", "Token expired", "#ef4444")] }
        }
      }

      if (resp.status < 200 || resp.status >= 300) {
        return { lines: [lineBadge("Error", "HTTP " + String(resp.status), "#ef4444")] }
      }

      let data
      try {
        data = JSON.parse(resp.bodyText)
      } catch {
        return { lines: [lineBadge("Error", "cannot parse usage response", "#ef4444")] }
      }

      const lines = []
      const nowSec = Math.floor(Date.now() / 1000)
      const rateLimit = data.rate_limit || null
      const primaryWindow = rateLimit && rateLimit.primary_window ? rateLimit.primary_window : null
      const secondaryWindow = rateLimit && rateLimit.secondary_window ? rateLimit.secondary_window : null
      const reviewWindow =
        data.code_review_rate_limit && data.code_review_rate_limit.primary_window
          ? data.code_review_rate_limit.primary_window
          : null

      const headerPrimary = readPercent(resp.headers["x-codex-primary-used-percent"])
      const headerSecondary = readPercent(resp.headers["x-codex-secondary-used-percent"])

      if (headerPrimary !== null) {
        lines.push(lineProgress("Session (5h)", headerPrimary, 100, "percent"))
        const resetIn = getResetIn(nowSec, primaryWindow)
        if (resetIn) lines.push(lineText("Resets in", resetIn))
      }
      if (headerSecondary !== null) {
        lines.push(lineProgress("Weekly (7d)", headerSecondary, 100, "percent"))
        const resetIn = getResetIn(nowSec, secondaryWindow)
        if (resetIn) lines.push(lineText("Resets in", resetIn))
      }

      if (lines.length === 0 && data.rate_limit) {
        if (data.rate_limit.primary_window && typeof data.rate_limit.primary_window.used_percent === "number") {
          lines.push(lineProgress("Session (5h)", data.rate_limit.primary_window.used_percent, 100, "percent"))
          const resetIn = getResetIn(nowSec, primaryWindow)
          if (resetIn) lines.push(lineText("Resets in", resetIn))
        }
        if (data.rate_limit.secondary_window && typeof data.rate_limit.secondary_window.used_percent === "number") {
          lines.push(lineProgress("Weekly (7d)", data.rate_limit.secondary_window.used_percent, 100, "percent"))
          const resetIn = getResetIn(nowSec, secondaryWindow)
          if (resetIn) lines.push(lineText("Resets in", resetIn))
        }
      }

      if (reviewWindow) {
        const used = reviewWindow.used_percent
        if (typeof used === "number") {
          lines.push(lineProgress("Reviews (7d)", used, 100, "percent"))
          const resetIn = getResetIn(nowSec, reviewWindow)
          if (resetIn) lines.push(lineText("Resets in", resetIn))
        }
      }

      const creditsBalance = resp.headers["x-codex-credits-balance"]
      const creditsHeader = readNumber(creditsBalance)
      const creditsData = data.credits ? readNumber(data.credits.balance) : null
      if (creditsHeader !== null) {
        lines.push(lineProgress("Credits", creditsHeader, 1000))
      } else if (creditsData !== null) {
        lines.push(lineProgress("Credits", creditsData, 1000))
      }

      if (data.plan_type) {
        const planLabel = formatPlanLabel(data.plan_type)
        if (planLabel) {
          lines.unshift(lineBadge("Plan", planLabel, "#000000"))
        }
      }

      if (lines.length === 0) {
        lines.push(lineBadge("Error", "No usage data", "#ef4444"))
      }

      return { lines }
    }

    if (auth.OPENAI_API_KEY) {
      return { lines: [lineBadge("Error", "Usage not available for API key", "#ef4444")] }
    }

    return { lines: [lineBadge("Error", "Login required", "#ef4444")] }
  }

  globalThis.__openusage_plugin = { id: "codex", probe }
})()
