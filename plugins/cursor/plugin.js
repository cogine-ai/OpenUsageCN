(function () {
  const STATE_DB =
    "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
  const BASE_URL = "https://api2.cursor.sh"
  const USAGE_URL = BASE_URL + "/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
  const PLAN_URL = BASE_URL + "/aiserver.v1.DashboardService/GetPlanInfo"
  const REFRESH_URL = BASE_URL + "/oauth/token"
  const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"
  const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 minutes before expiration

  function lineText(label, value, color) {
    const line = { type: "text", label, value }
    if (color) line.color = color
    return line
  }

  function lineProgress(label, value, max, unit, color) {
    return { type: "progress", label, value, max, unit, color }
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

  function readStateValue(ctx, key) {
    try {
      const sql =
        "SELECT value FROM ItemTable WHERE key = '" + key + "' LIMIT 1;"
      const json = ctx.host.sqlite.query(STATE_DB, sql)
      const rows = JSON.parse(json)
      if (rows.length > 0 && rows[0].value) {
        return rows[0].value
      }
    } catch (e) {
      ctx.host.log.warn("sqlite read failed for " + key + ": " + String(e))
    }
    return null
  }

  function writeStateValue(ctx, key, value) {
    try {
      // Escape single quotes in value for SQL
      const escaped = String(value).replace(/'/g, "''")
      const sql =
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('" +
        key +
        "', '" +
        escaped +
        "');"
      ctx.host.sqlite.exec(STATE_DB, sql)
      return true
    } catch (e) {
      ctx.host.log.warn("sqlite write failed for " + key + ": " + String(e))
      return false
    }
  }

  function decodeJwtPayload(token) {
    // JWT format: header.payload.signature
    // We need the payload (base64url encoded)
    try {
      const parts = token.split(".")
      if (parts.length !== 3) return null

      // Base64url decode the payload
      let payload = parts[1]
      // Replace base64url chars with base64 chars
      payload = payload.replace(/-/g, "+").replace(/_/g, "/")
      // Add padding if needed
      while (payload.length % 4) payload += "="

      // Decode base64 to string (works in QuickJS)
      const decoded = decodeBase64(payload)
      return JSON.parse(decoded)
    } catch (e) {
      return null
    }
  }

  function decodeBase64(str) {
    // Simple base64 decoder for QuickJS environment
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    let result = ""

    // Remove padding
    str = str.replace(/=+$/, "")

    const len = str.length
    let i = 0

    while (i < len) {
      const remaining = len - i

      const a = chars.indexOf(str.charAt(i++))
      const b = chars.indexOf(str.charAt(i++))
      const c = remaining > 2 ? chars.indexOf(str.charAt(i++)) : 0
      const d = remaining > 3 ? chars.indexOf(str.charAt(i++)) : 0

      const n = (a << 18) | (b << 12) | (c << 6) | d

      result += String.fromCharCode((n >> 16) & 0xff)
      if (remaining > 2) result += String.fromCharCode((n >> 8) & 0xff)
      if (remaining > 3) result += String.fromCharCode(n & 0xff)
    }

    return result
  }

  function getTokenExpiration(token) {
    const payload = decodeJwtPayload(token)
    if (!payload || typeof payload.exp !== "number") return null
    return payload.exp * 1000 // Convert to milliseconds
  }

  function needsRefresh(accessToken, nowMs) {
    if (!accessToken) return true
    const expiresAt = getTokenExpiration(accessToken)
    if (!expiresAt) return true
    return nowMs + REFRESH_BUFFER_MS >= expiresAt
  }

  function refreshToken(ctx, refreshTokenValue) {
    if (!refreshTokenValue) return null

    try {
      const resp = ctx.host.http.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/json" },
        bodyText: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: refreshTokenValue,
        }),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401) {
        let errorInfo = null
        try {
          errorInfo = JSON.parse(resp.bodyText)
        } catch {}
        if (errorInfo && errorInfo.shouldLogout === true) {
          throw "Session expired. Sign in via Cursor app."
        }
        throw "Token expired. Sign in via Cursor app."
      }

      if (resp.status < 200 || resp.status >= 300) return null

      const body = JSON.parse(resp.bodyText)

      // Check if server wants us to logout
      if (body.shouldLogout === true) {
        throw "Session expired. Sign in via Cursor app."
      }

      const newAccessToken = body.access_token
      if (!newAccessToken) return null

      // Persist updated access token to SQLite
      writeStateValue(ctx, "cursorAuth/accessToken", newAccessToken)

      // Note: Cursor refresh returns access_token which is used as both
      // access and refresh token in some flows
      return newAccessToken
    } catch (e) {
      if (typeof e === "string") throw e
      return null
    }
  }

  function connectPost(ctx, url, token) {
    return ctx.host.http.request({
      method: "POST",
      url: url,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      bodyText: "{}",
      timeoutMs: 10000,
    })
  }

  function dollarsFromCents(cents) {
    const d = cents / 100
    return Math.round(d * 100) / 100
  }

  function formatResetDate(unixMs) {
    const d = new Date(Number(unixMs))
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    return months[d.getMonth()] + " " + String(d.getDate())
  }

  function probe(ctx) {
    let accessToken = readStateValue(ctx, "cursorAuth/accessToken")
    const refreshTokenValue = readStateValue(ctx, "cursorAuth/refreshToken")

    if (!accessToken && !refreshTokenValue) {
      throw "Not logged in. Sign in via Cursor app."
    }

    const nowMs = Date.now()

    // Proactively refresh if token is expired or about to expire
    if (needsRefresh(accessToken, nowMs)) {
      let refreshed = null
      try {
        refreshed = refreshToken(ctx, refreshTokenValue)
      } catch (e) {
        // If refresh fails but we have an access token, try it anyway
        if (!accessToken) throw e
      }
      if (refreshed) {
        accessToken = refreshed
      } else if (!accessToken) {
        throw "Not logged in. Sign in via Cursor app."
      }
    }

    let usageResp
    try {
      usageResp = connectPost(ctx, USAGE_URL, accessToken)
    } catch (e) {
      throw "Usage request failed. Check your connection."
    }

    // On 401/403, try refreshing once and retry
    if (usageResp.status === 401 || usageResp.status === 403) {
      const refreshed = refreshToken(ctx, refreshTokenValue)
      if (!refreshed) {
        throw "Token expired. Sign in via Cursor app."
      }
      accessToken = refreshed
      try {
        usageResp = connectPost(ctx, USAGE_URL, accessToken)
      } catch (e) {
        throw "Usage request failed after refresh. Try again."
      }
      if (usageResp.status === 401 || usageResp.status === 403) {
        throw "Token expired. Sign in via Cursor app."
      }
    }

    if (usageResp.status < 200 || usageResp.status >= 300) {
      throw "Usage request failed (HTTP " + String(usageResp.status) + "). Try again later."
    }

    let usage
    try {
      usage = JSON.parse(usageResp.bodyText)
    } catch {
      throw "Usage response invalid. Try again later."
    }

    if (!usage.enabled || !usage.planUsage) {
      throw "Usage tracking disabled for this account."
    }

    let planName = ""
    try {
      const planResp = connectPost(ctx, PLAN_URL, accessToken)
      if (planResp.status >= 200 && planResp.status < 300) {
        const plan = JSON.parse(planResp.bodyText)
        if (plan.planInfo && plan.planInfo.planName) {
          planName = plan.planInfo.planName
        }
      }
    } catch (e) {
      ctx.host.log.warn("plan info fetch failed: " + String(e))
    }

    const lines = []
    if (planName) {
      const planLabel = formatPlanLabel(planName)
      if (planLabel) {
        lines.push(lineBadge("Plan", planLabel, "#000000"))
      }
    }

    const pu = usage.planUsage
    lines.push(
      lineProgress("Plan usage", dollarsFromCents(pu.totalSpend), dollarsFromCents(pu.limit), "dollars")
    )

    if (typeof pu.bonusSpend === "number" && pu.bonusSpend > 0) {
      lines.push(lineText("Bonus spend", "$" + String(dollarsFromCents(pu.bonusSpend))))
    }

    const su = usage.spendLimitUsage
    if (su) {
      const limit = su.individualLimit ?? su.pooledLimit ?? 0
      const remaining = su.individualRemaining ?? su.pooledRemaining ?? 0
      if (limit > 0) {
        const used = limit - remaining
        lines.push(
          lineProgress("On-demand", dollarsFromCents(used), dollarsFromCents(limit), "dollars")
        )
      }
    }

    if (usage.billingCycleEnd) {
      lines.push(lineText("Resets", formatResetDate(usage.billingCycleEnd)))
    }

    return { lines }
  }

  globalThis.__openusage_plugin = { id: "cursor", probe }
})()
