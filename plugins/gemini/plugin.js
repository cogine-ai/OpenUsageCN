(function () {
  const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
  const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
  const TOKEN_URL = "https://oauth2.googleapis.com/token"
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

  function configDir(ctx) {
    return (getConfig(ctx, "configDir") || getEnv(ctx, "GEMINI_CONFIG_DIR") || "~/.gemini").replace(/\/+$/, "")
  }

  function readJsonFile(ctx, path) {
    if (!ctx.host.fs.exists(path)) return null
    try {
      return ctx.util.tryParseJson(ctx.host.fs.readText(path))
    } catch (e) {
      ctx.host.log.warn("file read failed for " + path + ": " + String(e))
      return null
    }
  }

  function validateAuthType(ctx, dir) {
    const settings = readJsonFile(ctx, dir + "/settings.json")
    const raw = readString(settings && (settings.selectedAuthType || settings.authType || settings.auth_type))
    if (!raw) return
    const lower = raw.toLowerCase()
    if (lower.indexOf("api") !== -1 || lower.indexOf("vertex") !== -1) {
      throw "Gemini " + raw + " auth is not supported. Sign in with Gemini CLI Google account auth."
    }
  }

  function loadCredentials(ctx, dir) {
    const creds = readJsonFile(ctx, dir + "/oauth_creds.json")
    if (!creds || typeof creds !== "object") {
      throw "Gemini OAuth credentials not found. Sign in with Gemini CLI first."
    }
    return creds
  }

  function nowMs(ctx) {
    return ctx.util.parseDateMs(ctx.nowIso) || Date.now()
  }

  function expiryMs(creds) {
    const value = creds.expiry_date || creds.expiryDate || creds.expires_at || creds.expiresAt
    const n = readNumber(value)
    if (n === null) return null
    return Math.abs(n) < 1e10 ? n * 1000 : n
  }

  function formEncode(values) {
    const keys = Object.keys(values)
    const parts = []
    for (let i = 0; i < keys.length; i += 1) {
      parts.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(String(values[keys[i]])))
    }
    return parts.join("&")
  }

  function refreshAccessToken(ctx, creds) {
    const refreshToken = readString(creds.refresh_token || creds.refreshToken)
    const clientId = readString(creds.client_id || creds.clientId || creds.clientID)
    const clientSecret = readString(creds.client_secret || creds.clientSecret)
    if (!refreshToken || !clientId || !clientSecret) {
      throw "Gemini OAuth token expired. Run Gemini CLI sign-in again."
    }

    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: TOKEN_URL,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        bodyText: formEncode({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("token refresh exception: " + String(e))
      throw "Gemini OAuth refresh failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Gemini OAuth refresh failed. Run Gemini CLI sign-in again."
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Gemini OAuth refresh failed (HTTP " + String(resp.status) + "). Run Gemini CLI sign-in again."
    }

    const body = ctx.util.tryParseJson(resp.bodyText)
    const token = body && readString(body.access_token)
    if (!token) throw "Gemini OAuth refresh response invalid. Run Gemini CLI sign-in again."
    return token
  }

  function accessToken(ctx, creds) {
    const token = readString(creds.access_token || creds.accessToken)
    const expires = expiryMs(creds)
    if (token && (!expires || expires - nowMs(ctx) > 60 * 1000)) return token
    return refreshAccessToken(ctx, creds)
  }

  function postJson(ctx, url, token, body, soft) {
    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        bodyText: JSON.stringify(body || {}),
        timeoutMs: 15000,
      })
    } catch (e) {
      if (soft) {
        ctx.host.log.warn("request exception: " + String(e))
        return null
      }
      ctx.host.log.error("request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      if (soft) return null
      throw "Gemini OAuth session expired. Run Gemini CLI sign-in again."
    }
    if (resp.status < 200 || resp.status >= 300) {
      if (soft) return null
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object") {
      if (soft) return null
      throw "Usage response invalid. Try again later."
    }
    return parsed
  }

  function loadCodeAssist(ctx, token) {
    const data = postJson(ctx, LOAD_CODE_ASSIST_URL, token, {
      metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
    }, true)
    if (!data) return { plan: null, projectId: null }
    let projectId = readString(data.cloudaicompanionProject)
    if (!projectId && data.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
      projectId = readString(data.cloudaicompanionProject.id) || readString(data.cloudaicompanionProject.projectId)
    }
    const tier = readString(data.currentTier && data.currentTier.id)
    let plan = null
    if (tier === "standard-tier") plan = "Paid"
    if (tier === "free-tier") plan = "Free"
    if (tier === "legacy-tier") plan = "Legacy"
    return { plan, projectId }
  }

  function collectBuckets(value, out) {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) collectBuckets(value[i], out)
      return
    }
    const fraction = readNumber(value.remainingFraction)
    const modelId = readString(value.modelId || value.model || value.name)
    if (fraction !== null && modelId) {
      out.push({
        modelId,
        fraction,
        resetTime: readString(value.resetTime || value.reset_time || value.resetAt),
      })
    }
    const keys = Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) collectBuckets(value[keys[i]], out)
  }

  function labelForModel(modelId) {
    const lower = String(modelId).toLowerCase()
    if (lower.indexOf("flash-lite") !== -1 || lower.indexOf("flash_lite") !== -1) return "Flash Lite"
    if (lower.indexOf("flash") !== -1) return "Flash"
    if (lower.indexOf("pro") !== -1) return "Pro"
    return modelId
  }

  function quotaLines(ctx, quota) {
    const buckets = []
    collectBuckets(Array.isArray(quota && quota.buckets) ? quota.buckets : quota, buckets)
    if (buckets.length === 0) {
      throw "Gemini quota response invalid. Try again later."
    }

    const best = {}
    for (let i = 0; i < buckets.length; i += 1) {
      const label = labelForModel(buckets[i].modelId)
      if (!best[label] || buckets[i].fraction < best[label].fraction) {
        best[label] = buckets[i]
      }
    }

    const order = ["Pro", "Flash", "Flash Lite"]
    const lines = []
    for (let i = 0; i < order.length; i += 1) {
      const item = best[order[i]]
      if (!item) continue
      const remaining = item.fraction <= 1 ? item.fraction * 100 : item.fraction
      const used = Math.round(Math.max(0, Math.min(100, 100 - remaining)) * 10) / 10
      const opts = {
        label: order[i],
        used,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: DAY_MS,
      }
      const resetsAt = item.resetTime ? ctx.util.toIso(item.resetTime) : null
      if (resetsAt) opts.resetsAt = resetsAt
      lines.push(ctx.line.progress(opts))
    }

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }
    return lines
  }

  function probe(ctx) {
    const dir = configDir(ctx)
    validateAuthType(ctx, dir)
    const creds = loadCredentials(ctx, dir)
    const token = accessToken(ctx, creds)
    const assist = loadCodeAssist(ctx, token)
    const quotaBody = assist.projectId ? { project: assist.projectId } : {}
    const quota = postJson(ctx, QUOTA_URL, token, quotaBody, false)
    return { plan: assist.plan, lines: quotaLines(ctx, quota) }
  }

  globalThis.__openusage_plugin = { id: "gemini", probe }
})()
