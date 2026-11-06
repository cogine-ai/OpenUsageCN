(function () {
  const TOKEN_PATH = "~/.aws/sso/cache/kiro-auth-token.json"
  const PROFILE_PATH = "~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json"
  const REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
  const REFRESH_BUFFER_MS = 10 * 60 * 1000
  const DEFAULT_REGION = "us-east-1"
  const COUNT_FORMAT = { kind: "count", suffix: "credits" }
  const LOGIN_HINT = "Open Kiro and sign in, then try again."
  const SESSION_HINT = "Kiro session expired. Open Kiro and sign in again."
  const CHANGED_HINT = "Kiro connection changed. Refresh usage."
  const SAVE_HINT = "Kiro refreshed sign-in could not be saved. Check file access and try again."
  const DATA_HINT = "Kiro usage data unavailable. Check your connection and try again."

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
    let original
    try {
      if (!ctx.host.fs.existsStrict(TOKEN_PATH)) return null
      original = ctx.host.fs.readText(TOKEN_PATH)
    }
    catch (_) {
      ctx.host.log.error("Kiro desktop sign-in could not be read")
      throw "Kiro sign-in data could not be read. Check file access and try again."
    }
    const parsed = ctx.util.tryParseJson(original)
    if (!parsed || typeof parsed !== "object") return null
    const token = sanitizeAuth(parsed)
    return token && (token.refreshToken || token.accessToken)
      ? { path: TOKEN_PATH, token, originalHash: ctx.host.crypto.sha256Hex(original) } : null
  }
  function saveAuthState(ctx, authState) {
    const content = JSON.stringify(authState.token, null, 2)
    let saved
    try { saved = ctx.host.fs.writeTextIfUnchanged(authState.path, content, authState.originalHash) }
    catch (_) {
      ctx.host.log.error("Kiro refreshed desktop sign-in could not be saved")
      throw SAVE_HINT
    }
    if (!saved) {
      ctx.host.log.warn("Kiro desktop sign-in changed before refreshed credentials could be saved")
      throw CHANGED_HINT
    }
    authState.originalHash = ctx.host.crypto.sha256Hex(content)
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
    if (currentUsage === null || usageLimit === null || usageLimit < 0) return null
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
  function normalizeApiBreakdown(ctx, raw, rawSnapshot) {
    const value = normalizeBreakdown(ctx, raw)
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
    if (Array.isArray(raw.bonuses) && raw.bonuses.length || value.freeTrialUsage) {
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
        value.mainUnavailable = true
      }
    }
    value.resetDate = iso(ctx, raw.nextDateReset || raw.resetDate || rawSnapshot.nextDateReset)
    return value
  }
  function normalizeApiSnapshot(ctx, raw) {
    if (!raw || typeof raw !== "object") return null
    return {
      usageBreakdowns: Array.isArray(raw.usageBreakdownList)
        ? raw.usageBreakdownList.map((item) => normalizeApiBreakdown(ctx, item, raw)).filter(Boolean)
        : [],
      plan: title(raw.subscriptionInfo && raw.subscriptionInfo.subscriptionTitle),
      overageEnabled: raw.overageConfiguration && typeof raw.overageConfiguration.overageStatus === "string"
        ? raw.overageConfiguration.overageStatus.toUpperCase() === "ENABLED" ? true : raw.overageConfiguration.overageStatus.toUpperCase() === "DISABLED" ? false : null
        : null,
    }
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
    return normalizeApiSnapshot(ctx, parsed)
  }
  function pickPrimaryBreakdown(usageBreakdowns) {
    for (let i = 0; i < usageBreakdowns.length; i += 1) if (usageBreakdowns[i].type === "CREDIT") return usageBreakdowns[i]
    return usageBreakdowns.length ? usageBreakdowns[0] : null
  }
  function pickBonusUsage(primary) {
    return !primary ? null : primary.freeTrialUsage && primary.freeTrialUsage.usageLimit > 0 ? primary.freeTrialUsage : primary.bonuses && primary.bonuses.length ? primary.bonuses[0] : null
  }
  function buildOutput(ctx, snapshot) {
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
        return buildOutput(ctx, normalizeApiSnapshot(ctx, cli))
      }
    }
    const authState = loadAuthState(ctx)
    if (!authState || !authState.token || !authState.token.refreshToken) throw LOGIN_HINT
    let snapshot
    try {
      snapshot = fetchLiveState(ctx, authState, nowMs)
    } catch (error) {
      ctx.host.log.error("Kiro desktop usage request failed for the selected credentials")
      if (error === SESSION_HINT || error === CHANGED_HINT || error === SAVE_HINT) throw error
      throw "Kiro usage request failed. Check your connection."
    }
    if (!snapshot || !snapshot.usageBreakdowns.length) {
      ctx.host.log.error("Kiro desktop usage is unavailable for the selected credentials")
      throw DATA_HINT
    }
    return buildOutput(ctx, snapshot)
  }
  globalThis.__openusage_plugin = { id: "kiro", probe }
})()
