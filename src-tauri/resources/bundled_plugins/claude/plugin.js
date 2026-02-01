(function () {
  const CRED_FILE = "~/.claude/.credentials.json"
  const KEYCHAIN_SERVICE = "Claude Code-credentials"
  const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

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

  function loadCredentials(ctx) {
    if (ctx.host.fs.exists(CRED_FILE)) {
      try {
        const text = ctx.host.fs.readText(CRED_FILE)
        const parsed = JSON.parse(text)
        const oauth = parsed.claudeAiOauth
        if (oauth && oauth.accessToken) return oauth
      } catch (e) {
        ctx.host.log.warn("failed to parse credentials file: " + String(e))
      }
    }

    try {
      const keychainValue = ctx.host.keychain.readGenericPassword(KEYCHAIN_SERVICE)
      if (keychainValue) {
        const parsed = JSON.parse(keychainValue)
        const oauth = parsed.claudeAiOauth
        if (oauth && oauth.accessToken) return oauth
      }
    } catch (e) {
      ctx.host.log.warn("keychain read failed: " + String(e))
    }

    return null
  }

  function dollarsFromCents(cents) {
    const d = cents / 100
    return Math.round(d * 100) / 100
  }

  function probe(ctx) {
    const oauth = loadCredentials(ctx)
    if (!oauth || !oauth.accessToken || !oauth.accessToken.trim()) {
      return { lines: [lineBadge("Status", "Login required", "#f59e0b")] }
    }

    let resp
    try {
      resp = ctx.host.http.request({
        method: "GET",
        url: USAGE_URL,
        headers: {
          Authorization: "Bearer " + oauth.accessToken.trim(),
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "OpenUsage",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      return { lines: [lineBadge("Error", "usage request failed", "#ef4444")] }
    }

    if (resp.status === 401 || resp.status === 403) {
      return { lines: [lineBadge("Status", "Token expired", "#f59e0b")] }
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
    if (oauth.subscriptionType) {
      const planLabel = formatPlanLabel(oauth.subscriptionType)
      if (planLabel) {
        lines.push(lineBadge("Plan", planLabel, "#000000"))
      }
    }

    if (data.five_hour && typeof data.five_hour.utilization === "number") {
      lines.push(lineProgress("Session (5h)", data.five_hour.utilization, 100, "percent"))
    }
    if (data.seven_day && typeof data.seven_day.utilization === "number") {
      lines.push(lineProgress("Weekly (7d)", data.seven_day.utilization, 100, "percent"))
    }
    if (data.seven_day_opus && typeof data.seven_day_opus.utilization === "number") {
      lines.push(lineProgress("Opus (7d)", data.seven_day_opus.utilization, 100, "percent"))
    }

    if (data.extra_usage && data.extra_usage.is_enabled) {
      const used = data.extra_usage.used_credits
      const limit = data.extra_usage.monthly_limit
      if (typeof used === "number" && typeof limit === "number" && limit > 0) {
        lines.push(
          lineProgress("Extra usage", dollarsFromCents(used), dollarsFromCents(limit), "dollars")
        )
      } else if (typeof used === "number" && used > 0) {
        lines.push(lineText("Extra usage", "$" + String(dollarsFromCents(used))))
      }
    }

    if (lines.length === 0) {
      lines.push(lineBadge("Status", "Connected", "#22c55e"))
    }

    return { lines }
  }

  globalThis.__openusage_plugin = { id: "claude", probe }
})()
