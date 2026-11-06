(function () {
  const STATE_DB = "~/Library/Application Support/Kiro/User/globalStorage/state.vscdb"
  const STATE_KEY = "kiro.kiroAgent"
  const LOGS_ROOT = "~/Library/Application Support/Kiro/logs"
  const LOG_FILE_NAME = "q-client.log"
  const TOKEN_PATH = "~/.aws/sso/cache/kiro-auth-token.json"
  const PROFILE_PATH = "~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json"
  const REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
  const LIVE_STALE_MS = 15 * 60 * 1000
  const REFRESH_BUFFER_MS = 10 * 60 * 1000
  const DEFAULT_REGION = "us-east-1"
  const COUNT_FORMAT = { kind: "count", suffix: "credits" }
  const LOGIN_HINT = "Open Kiro and sign in, then try again."
  const SESSION_HINT = "Kiro session expired. Open Kiro and sign in again."
  const DATA_HINT = "Kiro usage data unavailable. Open the Kiro account dashboard once and try again."

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string" || !value.trim()) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  function first() {
    for (let i = 0; i < arguments.length; i += 1) {
      const value = num(arguments[i])
      if (value !== null) return value
    }
    return null
  }
  function iso(ctx, value) {
    const normalized = ctx.util.toIso(value)
    return typeof normalized === "string" && normalized ? normalized : null
  }
  function title(value) {
    const trimmed = String(value || "").trim()
    return trimmed
      ? trimmed
          .toLowerCase()
          .split(/\s+/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
      : null
  }
  function sanitizeAuth(token) {
    if (!token || typeof token !== "object") return null
    if (token.provider === "Google" || token.provider === "Github") return { ...token, authMethod: "social" }
    if (token.provider === "ExternalIdp") return { ...token, authMethod: "external_idp" }
    if (token.provider === "Enterprise" || token.provider === "BuilderId" || token.provider === "Internal") {
      return { ...token, authMethod: "IdC" }
    }
    return token
  }
  function readJsonFile(ctx, path, label) {
    if (!ctx.host.fs.exists(path)) return null
    try {
      return ctx.util.tryParseJson(ctx.host.fs.readText(path))
    } catch (e) {
      ctx.host.log.warn(label + " read failed: " + String(e))
      return null
    }
  }
  function loadAuthState(ctx) {
    const parsed = readJsonFile(ctx, TOKEN_PATH, "auth token")
    if (!parsed || typeof parsed !== "object") return null
    const token = sanitizeAuth(parsed)
    return token && (token.refreshToken || token.accessToken) ? { path: TOKEN_PATH, token } : null
  }
  function saveAuthState(ctx, authState) {
    try {
      ctx.host.fs.writeText(authState.path, JSON.stringify(authState.token, null, 2))
      return true
    } catch (e) {
      ctx.host.log.warn("failed to persist refreshed Kiro auth: " + String(e))
      return false
    }
  }
  function loadProfileArn(ctx, authState) {
    const fromToken = authState && authState.token && authState.token.profileArn
    if (typeof fromToken === "string" && fromToken) return fromToken
    const parsed = readJsonFile(ctx, PROFILE_PATH, "profile")
    return parsed && typeof parsed.arn === "string" && parsed.arn.trim() ? parsed.arn.trim() : null
  }
  function regionFromArn(profileArn) {
    const parts = String(profileArn || "").split(":")
    return parts.length > 3 && parts[3] ? parts[3] : DEFAULT_REGION
  }
  function readStateValue(ctx, key) {
    try {
      const sql = "SELECT value FROM ItemTable WHERE key = '" + String(key).replace(/'/g, "''") + "' LIMIT 1;"
      const rows = ctx.util.tryParseJson(ctx.host.sqlite.query(STATE_DB, sql))
      return Array.isArray(rows) && rows.length && typeof rows[0].value === "string" ? rows[0].value : null
    } catch (e) {
      ctx.host.log.warn("Kiro sqlite read failed: " + String(e))
      return null
    }
  }
  function normalizePool(ctx, raw, config) {
    if (!raw || typeof raw !== "object") return null
    if (config.statusKey) {
      const status = raw[config.statusKey]
      if (status && !config.allowedStatuses.includes(status)) return null
    }
    const currentUsage = first(raw[config.preciseCurrent], raw[config.current])
    const usageLimit = first(raw[config.preciseLimit], raw[config.limit])
    if (currentUsage === null || usageLimit === null || usageLimit <= 0) return null
    return {
      currentUsage,
      usageLimit,
      expiryDate: iso(ctx, raw[config.expiryA] || raw[config.expiryB]),
      displayName: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : null,
    }
  }
  function normalizeBreakdown(ctx, raw) {
    if (!raw || typeof raw !== "object") return null
    const currentUsage = first(raw.currentUsageWithPrecision, raw.currentUsage)
    const usageLimit = first(raw.usageLimitWithPrecision, raw.usageLimit)
    if (currentUsage === null || usageLimit === null || usageLimit <= 0) return null
    const bonuses = Array.isArray(raw.bonuses)
      ? raw.bonuses
          .map((item) =>
            normalizePool(ctx, item, {
              current: "currentUsage",
              preciseCurrent: null,
              limit: "usageLimit",
              preciseLimit: null,
              expiryA: "expiresAt",
              expiryB: "expiryDate",
              statusKey: "status",
              allowedStatuses: ["ACTIVE", "EXHAUSTED"],
            })
          )
          .filter(Boolean)
      : []

    return {
      type: typeof raw.resourceType === "string" ? raw.resourceType : raw.type,
      currentUsage,
      usageLimit,
      resetDate: iso(ctx, raw.nextDateReset || raw.resetDate),
      freeTrialUsage: normalizePool(ctx, raw.freeTrialInfo || raw.freeTrialUsage, {
        current: "currentUsage",
        preciseCurrent: "currentUsageWithPrecision",
        limit: "usageLimit",
        preciseLimit: "usageLimitWithPrecision",
        expiryA: "freeTrialExpiry",
        expiryB: "expiryDate",
        statusKey: "freeTrialStatus",
        allowedStatuses: ["ACTIVE"],
      }),
      bonuses,
    }
  }
  function normalizeCachedState(ctx) {
    const parsed = ctx.util.tryParseJson(readStateValue(ctx, STATE_KEY))
    const usageState = parsed && parsed["kiro.resourceNotifications.usageState"]
    if (!usageState || !Array.isArray(usageState.usageBreakdowns)) return null
    const usageBreakdowns = usageState.usageBreakdowns.map((item) => normalizeBreakdown(ctx, item)).filter(Boolean)
    return usageBreakdowns.length
      ? { usageBreakdowns, timestampMs: first(usageState.timestamp), plan: null, overageEnabled: null }
      : null
  }
  function normalizeApiBreakdown(ctx, raw, rawSnapshot) {
    let value = normalizeBreakdown(ctx, raw)
    if (!value && raw && typeof raw === "object" && first(raw.usageLimitWithPrecision, raw.usageLimit) === 0) {
      value = { type: raw.resourceType || raw.type, currentUsage: first(raw.currentUsageWithPrecision, raw.currentUsage), usageLimit: 0, bonuses: [] }
    }
    if (!value) return null
    const overage = first(raw.currentOveragesWithPrecision, raw.currentOverages)
    if (overage !== null) {
      if (overage < 0 || overage > value.currentUsage) {
        ctx.host.log.error("Kiro overage exceeds total usage or is invalid")
        value.mainUnavailable = true
      } else {
        value.currentUsage -= overage
        value.overageUsage = overage
      }
    }
    // API usage folds bonus spend into the total; it cannot establish an isolated plan meter.
    if (Array.isArray(raw.bonuses) && raw.bonuses.length) {
      ctx.host.log.warn("Kiro API plan usage includes an unseparated bonus pool")
      value.mainUnavailable = true
    }
    if (value.currentUsage < 0 || value.currentUsage > value.usageLimit) {
      ctx.host.log.warn("Kiro API plan usage cannot be separated from its reported limit")
      value.mainUnavailable = true
    }
    const status = rawSnapshot.overageConfiguration && rawSnapshot.overageConfiguration.overageStatus
    if (typeof status === "string" && status.toUpperCase() === "ENABLED") {
      const cap = first(raw.overageCapWithPrecision, raw.overageCap)
      if (cap !== null && cap >= 0) value.overageCap = cap
      if (value.overageUsage === undefined) {
        ctx.host.log.warn("Kiro overage amount was not reported")
        value.overageUnavailable = true
      }
    }
    value.resetDate = iso(ctx, raw.nextDateReset || raw.resetDate || rawSnapshot.nextDateReset)
    return value
  }
  function normalizeApiSnapshot(ctx, raw, timestampMs) {
    if (!raw || typeof raw !== "object") return null
    return {
      usageBreakdowns: Array.isArray(raw.usageBreakdownList)
        ? raw.usageBreakdownList.map((item) => normalizeApiBreakdown(ctx, item, raw)).filter(Boolean)
        : [],
      timestampMs: timestampMs !== null ? timestampMs : null,
      plan: title(raw.subscriptionInfo && raw.subscriptionInfo.subscriptionTitle),
      overageEnabled: raw.overageConfiguration && typeof raw.overageConfiguration.overageStatus === "string"
        ? raw.overageConfiguration.overageStatus.toUpperCase() === "ENABLED" ? true : raw.overageConfiguration.overageStatus.toUpperCase() === "DISABLED" ? false : null
        : null,
    }
  }
  function parseUsageLogText(ctx, text) {
    const lines = String(text || "").split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (line.indexOf('"commandName":"GetUsageLimitsCommand"') === -1) continue
      const jsonStart = line.indexOf("{")
      if (jsonStart === -1) continue
      const parsed = ctx.util.tryParseJson(line.slice(jsonStart))
      if (!parsed || !parsed.output) continue
      const loggedAt = line.slice(0, jsonStart).trim().split(" [")[0]
      return normalizeApiSnapshot(ctx, parsed.output, loggedAt ? ctx.util.parseDateMs(loggedAt.replace(" ", "T")) : null)
    }
    return null
  }
  function loadLoggedState(ctx) {
    let sessions = []
    try {
      sessions = ctx.host.fs.listDir(LOGS_ROOT).slice().sort().reverse()
    } catch {
      return null
    }
    for (let i = 0; i < sessions.length && i < 12; i += 1) {
      const sessionRoot = LOGS_ROOT + "/" + sessions[i]
      let windows = []
      try {
        windows = ctx.host.fs.listDir(sessionRoot).slice().sort().reverse()
      } catch {
        continue
      }
      for (let j = 0; j < windows.length; j += 1) {
        const logPath = sessionRoot + "/" + windows[j] + "/exthost/kiro.kiroAgent/" + LOG_FILE_NAME
        if (!ctx.host.fs.exists(logPath)) continue
        try {
          const snapshot = parseUsageLogText(ctx, ctx.host.fs.readText(logPath))
          if (snapshot) return snapshot
        } catch (e) {
          ctx.host.log.warn("failed to parse Kiro usage log: " + String(e))
        }
      }
    }
    return null
  }
  function buildUserAgent(ctx) {
    return "OpenUsageCN/" + String(ctx.app && ctx.app.version ? ctx.app.version : "0.0.0")
  }
  function needsRefresh(ctx, authState, nowMs) {
    return ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: ctx.util.parseDateMs(authState.token && authState.token.expiresAt),
      bufferMs: REFRESH_BUFFER_MS,
    })
  }
  function buildUsageHeaders(ctx, authState, accessToken) {
    const headers = { Authorization: "Bearer " + accessToken, Accept: "application/json", "User-Agent": buildUserAgent(ctx) }
    if (authState.token && authState.token.authMethod === "external_idp") headers.TokenType = "EXTERNAL_IDP"
    if (authState.token && authState.token.provider === "Internal") headers["redirect-for-internal"] = "true"
    return headers
  }
  function refreshAccessToken(ctx, authState, nowMs) {
    if (!authState.token || !authState.token.refreshToken) throw SESSION_HINT
    const { resp, json } = ctx.util.requestJson({
      method: "POST",
      url: REFRESH_URL,
      headers: { "Content-Type": "application/json", "User-Agent": buildUserAgent(ctx) },
      bodyText: JSON.stringify({ refreshToken: authState.token.refreshToken }),
      timeoutMs: 15000,
    })
    if (ctx.util.isAuthStatus(resp.status)) throw SESSION_HINT
    if (resp.status < 200 || resp.status >= 300 || !json || typeof json.accessToken !== "string" || !json.accessToken) {
      ctx.host.log.warn("Kiro token refresh failed: HTTP " + resp.status)
      return null
    }
    const expiresIn = first(json.expiresIn, json.expires_in)
    authState.token = sanitizeAuth({
      ...authState.token,
      accessToken: json.accessToken,
      refreshToken: typeof json.refreshToken === "string" && json.refreshToken ? json.refreshToken : authState.token.refreshToken,
      profileArn: typeof json.profileArn === "string" && json.profileArn ? json.profileArn : authState.token.profileArn,
      expiresAt: expiresIn !== null && expiresIn > 0 ? new Date(nowMs + expiresIn * 1000).toISOString() : authState.token.expiresAt,
    })
    saveAuthState(ctx, authState)
    return authState.token.accessToken
  }
  function fetchLiveState(ctx, authState, nowMs) {
    const profileArn = loadProfileArn(ctx, authState)
    if (!profileArn) return null
    const url =
      "https://q." +
      regionFromArn(profileArn) +
      ".amazonaws.com/getUsageLimits?origin=" +
      encodeURIComponent("AI_EDITOR") +
      "&profileArn=" +
      encodeURIComponent(profileArn) +
      "&resourceType=" +
      encodeURIComponent("AGENTIC_REQUEST")

    let accessToken = authState.token && authState.token.accessToken
    if (!accessToken || needsRefresh(ctx, authState, nowMs)) {
      const refreshed = refreshAccessToken(ctx, authState, nowMs)
      if (refreshed) accessToken = refreshed
    }
    if (!accessToken) throw SESSION_HINT

    const resp = ctx.util.retryOnceOnAuth({
      request: (tokenOverride) =>
        ctx.util.request({
          method: "GET",
          url,
          headers: buildUsageHeaders(ctx, authState, tokenOverride || accessToken),
          timeoutMs: 15000,
        }),
      refresh: () => refreshAccessToken(ctx, authState, nowMs),
    })

    if (ctx.util.isAuthStatus(resp.status)) throw SESSION_HINT
    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("Kiro live usage request failed: HTTP " + resp.status)
      return null
    }
    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed) {
      ctx.host.log.warn("Kiro live usage response invalid JSON")
      return null
    }
    return normalizeApiSnapshot(ctx, parsed, nowMs)
  }
  function shouldTryLive(localState, loggedState, nowMs) {
    return !localState || !loggedState || !loggedState.plan || localState.timestampMs === null || nowMs - localState.timestampMs > LIVE_STALE_MS
  }
  function mergeSnapshots(localState, loggedState, liveState, nowMs) {
    const usageSource =
      liveState && liveState.usageBreakdowns.length
        ? liveState
        : localState && localState.usageBreakdowns.length
          ? localState
          : loggedState && loggedState.usageBreakdowns.length
            ? loggedState
            : null
    if (!usageSource) return null
    return {
      plan: (liveState && liveState.plan) || (loggedState && loggedState.plan) || null,
      overageEnabled:
        liveState && liveState.overageEnabled !== null
          ? liveState.overageEnabled
          : loggedState && loggedState.overageEnabled !== null
            ? loggedState.overageEnabled
            : null,
      usageBreakdowns: usageSource.usageBreakdowns.map((item) => {
        const metadata = liveState || (loggedState && loggedState.timestampMs !== null && nowMs - loggedState.timestampMs <= LIVE_STALE_MS ? loggedState : null)
        const matching = metadata && metadata.usageBreakdowns.find((candidate) => candidate.type === item.type)
        return matching && matching !== item ? { ...item, overageUsage: matching.overageUsage, overageCap: matching.overageCap, overageUnavailable: matching.overageUnavailable } : item
      }),
      timestampMs: usageSource.timestampMs !== null ? usageSource.timestampMs : nowMs,
    }
  }
  function pickPrimaryBreakdown(usageBreakdowns) {
    for (let i = 0; i < usageBreakdowns.length; i += 1) if (usageBreakdowns[i].type === "CREDIT") return usageBreakdowns[i]
    return usageBreakdowns.length ? usageBreakdowns[0] : null
  }
  function pickBonusUsage(primary) {
    return !primary ? null : primary.freeTrialUsage && primary.freeTrialUsage.usageLimit > 0 ? primary.freeTrialUsage : primary.bonuses && primary.bonuses.length ? primary.bonuses[0] : null
  }
  function formatAge(nowMs, timestampMs) {
    if (!Number.isFinite(nowMs) || !Number.isFinite(timestampMs)) return null
    const diffMs = Math.max(0, nowMs - timestampMs)
    if (diffMs < 60000) return "Just now"
    const minutes = Math.floor(diffMs / 60000)
    if (minutes < 60) return minutes + "m ago"
    const hours = Math.floor(minutes / 60)
    return hours < 48 ? hours + "h ago" : Math.floor(hours / 24) + "d ago"
  }
  function buildOutput(ctx, snapshot, nowMs) {
    const primary = pickPrimaryBreakdown(snapshot.usageBreakdowns)
    if (!primary) throw DATA_HINT
    const lines = []
    if (primary.mainUnavailable || primary.currentUsage === null) {
      lines.push(ctx.line.badge({ label: "Credits", text: "Usage unavailable", color: "#f59e0b" }))
    } else if (primary.usageLimit === 0) {
      lines.push(ctx.line.text({ label: "Credits", value: primary.currentUsage + " / 0 credits" }))
    } else {
      lines.push(ctx.line.progress({ label: "Credits", used: primary.currentUsage, limit: primary.usageLimit, format: COUNT_FORMAT, resetsAt: primary.resetDate || undefined }))
    }
    if (typeof primary.overageUsage === "number") {
      if (typeof primary.overageCap === "number" && primary.overageCap > 0) {
        lines.push(ctx.line.progress({ label: "Overage Credits", used: primary.overageUsage, limit: primary.overageCap, format: COUNT_FORMAT, resetsAt: primary.resetDate || undefined }))
      } else {
        lines.push(ctx.line.text({ label: "Overage Credits", value: primary.overageUsage + (primary.overageCap === 0 ? " / 0 credits" : " credits used; limit not reported") }))
      }
    }
    if (primary.overageUnavailable) lines.push(ctx.line.text({ label: "Overage Credits", value: "Unavailable" }))
    const bonusUsage = pickBonusUsage(primary)
    if (bonusUsage) {
      lines.push(
        ctx.line.progress({
          label: "Bonus Credits",
          used: bonusUsage.currentUsage,
          limit: bonusUsage.usageLimit,
          format: COUNT_FORMAT,
        })
      )
      if (bonusUsage.expiryDate) lines.push(ctx.line.text({ label: "Bonus Expiry", value: bonusUsage.expiryDate }))
    }
    if (snapshot.overageEnabled !== null) lines.push(ctx.line.badge({ label: "Overages", text: snapshot.overageEnabled ? "Enabled" : "Disabled" }))
    return { plan: snapshot.plan || undefined, lines }
  }
  function hasDesktopAuth(ctx) {
    try { return ctx.host.fs.existsStrict(TOKEN_PATH) }
    catch (_) {
      ctx.host.log.error("Kiro desktop sign-in status could not be verified")
      throw "Could not verify Kiro desktop sign-in. Check file access and try again."
    }
  }
  function probe(ctx) {
    const nowMs = ctx.util.parseDateMs(ctx.nowIso) || Date.now()
    if (!hasDesktopAuth(ctx)) {
      const cli = globalThis.__openusage_kiro_cli.read(ctx)
      if (cli) {
        if (hasDesktopAuth(ctx)) {
          ctx.host.log.warn("Kiro selected sign-in source changed during refresh")
          throw "Kiro connection changed. Refresh usage."
        }
        return buildOutput(ctx, normalizeApiSnapshot(ctx, cli, nowMs), nowMs)
      }
    }
    const authState = loadAuthState(ctx)
    if (!authState || !authState.token || !authState.token.refreshToken) throw LOGIN_HINT
    const localState = normalizeCachedState(ctx)
    const loggedState = loadLoggedState(ctx)
    let liveState = null
    let liveError = null
    if (shouldTryLive(localState, loggedState, nowMs)) {
      try {
        liveState = fetchLiveState(ctx, authState, nowMs)
      } catch (e) {
        liveError = e
        ctx.host.log.warn("Kiro live fallback failed: " + String(e))
      }
    }
    const snapshot = mergeSnapshots(localState, loggedState, liveState, nowMs)
    if (!snapshot) {
      if (typeof liveError === "string" && liveError) throw liveError
      throw DATA_HINT
    }
    return buildOutput(ctx, snapshot, nowMs)
  }
  globalThis.__openusage_plugin = { id: "kiro", probe }
})()
