(function () {
  const AUTH_PATH = "~/.grok/auth.json"
  const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
  const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
  const REFRESH_URL = "https://auth.x.ai/oauth2/token"
  const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
  const TOKEN_AUTH_HEADER = "xai-grok-cli"
  const AUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000
  const LOGIN_HINT = "Grok auth expired. Run `grok login` again."

  function rawDigest(ctx, text) {
    if (!ctx.host.crypto || typeof ctx.host.crypto.sha256Hex !== "function") return null
    return ctx.host.crypto.sha256Hex(String(text))
  }

  function loadAuthFile(ctx) {
    if (!ctx.host.fs.exists(AUTH_PATH)) return null
    try {
      const text = ctx.host.fs.readText(AUTH_PATH)
      const auth = ctx.util.tryParseJson(text)
      if (!auth || typeof auth !== "object") return null
      return { auth, rawDigest: rawDigest(ctx, text) }
    } catch {
      return null
    }
  }

  function saveAuthFile(ctx, authState) {
    const content = JSON.stringify(authState.auth, null, 2)
    try {
      if (
        authState.rawDigest &&
        ctx.host.fs &&
        typeof ctx.host.fs.writeTextIfUnchanged === "function"
      ) {
        const persisted = ctx.host.fs.writeTextIfUnchanged(
          AUTH_PATH,
          content,
          authState.rawDigest
        )
        if (!persisted) {
          ctx.host.log.warn(
            "Grok auth file changed mid-refresh; refusing overwrite: " + AUTH_PATH
          )
          return false
        }
        authState.rawDigest = rawDigest(ctx, content)
        return true
      }

      if (authState.rawDigest && ctx.host.fs && typeof ctx.host.fs.readText === "function") {
        let currentText = null
        try {
          currentText = ctx.host.fs.exists(AUTH_PATH)
            ? ctx.host.fs.readText(AUTH_PATH)
            : null
        } catch (e) {
          currentText = null
        }
        if (
          currentText != null &&
          rawDigest(ctx, currentText) !== authState.rawDigest
        ) {
          ctx.host.log.warn(
            "Grok auth file changed mid-refresh; refusing overwrite: " + AUTH_PATH
          )
          return false
        }
      }

      ctx.host.fs.writeText(AUTH_PATH, content)
      authState.rawDigest = rawDigest(ctx, content)
      return true
    } catch (e) {
      ctx.host.log.warn("Grok auth refresh succeeded but failed to save auth: " + String(e))
      return false
    }
  }

  function entryExpiresAtMs(ctx, entry) {
    if (!entry || typeof entry !== "object") return null
    if (entry.expires_at) return ctx.util.parseDateMs(entry.expires_at)
    if (entry.expires) return ctx.util.parseDateMs(entry.expires)
    return null
  }

  function tokenExpiresAtMs(ctx, token) {
    const payload = ctx.jwt.decodePayload(token)
    if (!payload || typeof payload.exp !== "number") return null
    return payload.exp * 1000
  }

  function needsRefresh(ctx, entry, token, nowMs) {
    const entryMs = entryExpiresAtMs(ctx, entry)
    const tokenMs = tokenExpiresAtMs(ctx, token)
    const entryNeedsRefresh = entryMs !== null && ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: entryMs,
      bufferMs: AUTH_REFRESH_BUFFER_MS,
    })
    const tokenNeedsRefresh = tokenMs !== null && ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: tokenMs,
      bufferMs: AUTH_REFRESH_BUFFER_MS,
    })
    return entryNeedsRefresh || tokenNeedsRefresh
  }

  function isExpired(ctx, entry, token, nowMs) {
    const entryMs = entryExpiresAtMs(ctx, entry)
    const tokenMs = tokenExpiresAtMs(ctx, token)
    const expiresAtMs = tokenMs !== null ? tokenMs : entryMs
    if (expiresAtMs === null) return false
    return nowMs >= expiresAtMs
  }

  function readRefreshToken(entry) {
    if (!entry || typeof entry !== "object") return ""
    const refreshToken = typeof entry.refresh_token === "string" ? entry.refresh_token.trim() : ""
    if (refreshToken) return refreshToken
    return typeof entry.refresh === "string" ? entry.refresh.trim() : ""
  }

  function readClientId(entryKey, entry) {
    if (entry && typeof entry.oidc_client_id === "string" && entry.oidc_client_id.trim()) {
      return entry.oidc_client_id.trim()
    }
    const parts = String(entryKey || "").split("::")
    const fromKey = parts.length > 1 ? parts[parts.length - 1].trim() : ""
    return fromKey || DEFAULT_CLIENT_ID
  }

  function nowMs(ctx) {
    return ctx.util.parseDateMs(ctx.nowIso) || Date.now()
  }

  function refreshAuth(ctx, authState, entryKey, entry) {
    const refreshToken = readRefreshToken(entry)
    if (!refreshToken) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting Grok auth refresh")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" + encodeURIComponent(readClientId(entryKey, entry)) +
          "&refresh_token=" + encodeURIComponent(refreshToken),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        const body = ctx.util.tryParseJson(resp.bodyText)
        const code = body && ((body.error && body.error.code) || body.error || body.code)
        ctx.host.log.error("Grok auth refresh failed: status=" + resp.status + " code=" + String(code))
        return null
      }
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("Grok auth refresh returned status: " + resp.status)
        return null
      }

      const body = ctx.util.tryParseJson(resp.bodyText)
      if (!body || typeof body.access_token !== "string" || !body.access_token.trim()) {
        ctx.host.log.warn("Grok auth refresh response missing access_token")
        return null
      }

      const accessToken = body.access_token.trim()
      entry.key = accessToken
      if (typeof body.refresh_token === "string" && body.refresh_token.trim()) {
        entry.refresh_token = body.refresh_token.trim()
      }
      if (typeof body.id_token === "string" && body.id_token.trim()) {
        entry.id_token = body.id_token.trim()
      }

      const refreshedAtMs = nowMs(ctx)
      const expiresIn = Number(body.expires_in)
      const tokenExpiryMs = tokenExpiresAtMs(ctx, accessToken)
      const expiresAtMs = Number.isFinite(expiresIn) && expiresIn > 0
        ? refreshedAtMs + expiresIn * 1000
        : tokenExpiryMs || refreshedAtMs + 3600 * 1000
      entry.expires_at = new Date(expiresAtMs).toISOString()

      if (!saveAuthFile(ctx, authState)) {
        return null
      }
      ctx.host.log.info("Grok auth refresh succeeded, token persisted")

      return accessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("Grok auth refresh exception: " + String(e))
      return null
    }
  }

  function loadAuth(ctx) {
    const authState = loadAuthFile(ctx)
    if (!authState) {
      throw "Grok not logged in. Run `grok login`."
    }

    const auth = authState.auth
    const currentMs = nowMs(ctx)
    let expiredCandidate = false
    const keys = Object.keys(auth)
    for (let i = 0; i < keys.length; i++) {
      const entryKey = keys[i]
      const entry = auth[entryKey]
      if (!entry || typeof entry !== "object") continue
      const token = typeof entry.key === "string" ? entry.key.trim() : ""
      if (!token) continue
      if (needsRefresh(ctx, entry, token, currentMs)) {
        const refreshed = refreshAuth(ctx, authState, entryKey, entry)
        if (refreshed) return { authState, entryKey, entry, token: refreshed }
        if (!isExpired(ctx, entry, token, currentMs)) {
          ctx.host.log.warn("Grok refresh failed, trying existing access token")
          return { authState, entryKey, entry, token }
        }
        expiredCandidate = true
        continue
      }
      return { authState, entryKey, entry, token }
    }

    if (expiredCandidate) {
      throw LOGIN_HINT
    }
    throw "Grok auth invalid. Run `grok login` again."
  }

  function unitsValue(obj) {
    if (!obj || typeof obj !== "object") return null
    const n = Number(obj.val)
    return Number.isFinite(n) ? n : null
  }

  function clampPercent(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    if (n < 0) return 0
    if (n > 100) return 100
    return n
  }

  function fetchBillingResponse(ctx, token) {
    try {
      return ctx.util.request({
        method: "GET",
        url: BILLING_URL,
        headers: {
          Authorization: "Bearer " + token,
          "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
          Accept: "application/json",
          "User-Agent": "OpenUsageCN",
        },
        timeoutMs: 10000,
      })
    } catch {
      throw "Grok billing request failed. Check your connection."
    }
  }

  function parseBilling(ctx, resp) {
    if (ctx.util.isAuthStatus(resp.status)) {
      throw LOGIN_HINT
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Grok billing request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data) {
      throw "Grok billing response changed."
    }
    return data
  }

  function fetchPlanName(ctx, token) {
    try {
      const resp = ctx.util.request({
        method: "GET",
        url: SETTINGS_URL,
        headers: {
          Authorization: "Bearer " + token,
          "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
          Accept: "application/json",
          "User-Agent": "OpenUsageCN",
        },
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) return null
      const data = ctx.util.tryParseJson(resp.bodyText)
      const plan = data && data.subscription_tier_display
      return typeof plan === "string" && plan.trim() ? plan.trim() : null
    } catch {
      return null
    }
  }

  function probe(ctx) {
    const auth = loadAuth(ctx)
    const billingResp = ctx.util.retryOnceOnAuth({
      request: (token) => fetchBillingResponse(ctx, token || auth.token),
      refresh: () => {
        const refreshed = refreshAuth(ctx, auth.authState, auth.entryKey, auth.entry)
        if (refreshed) auth.token = refreshed
        return refreshed
      },
    })
    const data = parseBilling(ctx, billingResp)
    const config = data && data.config
    if (!config || typeof config !== "object") {
      throw "Grok billing response changed."
    }

    const usedUnits = unitsValue(config.used)
    const limitUnits = unitsValue(config.monthlyLimit)
    const onDemandCapUnits = unitsValue(config.onDemandCap)
    if (usedUnits === null || limitUnits === null || limitUnits <= 0 || onDemandCapUnits === null) {
      throw "Grok billing response changed."
    }

    const resetsAt = ctx.util.toIso(config.billingPeriodEnd)
    if (!resetsAt) {
      throw "Grok billing response changed."
    }

    const usedPercent = clampPercent((usedUnits / limitUnits) * 100)
    const lines = [
      ctx.line.progress({
        label: "Credits used",
        used: usedPercent,
        limit: 100,
        format: { kind: "percent" },
        resetsAt,
      }),
      ctx.line.badge({
        label: "Pay as you go",
        text: onDemandCapUnits > 0 ? String(onDemandCapUnits) + " cap" : "Disabled",
        color: onDemandCapUnits > 0 ? "#22c55e" : "#a3a3a3",
      }),
    ]

    return { plan: fetchPlanName(ctx, auth.token), lines }
  }

  globalThis.__openusage_plugin = { id: "grok", probe }
})()
