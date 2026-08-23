(function () {
  const AUTH_FILE = "auth.json"
  const CONFIG_AUTH_PATHS = ["~/.config/codex", "~/.codex"]
  const KEYCHAIN_SERVICE = "Codex Auth"
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  const REFRESH_URL = "https://auth.openai.com/oauth/token"
  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
  const RATE_LIMIT_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
  const CREDIT_USD_RATE = 0.04
  const REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000
  const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000
  const ERR_NOT_LOGGED_IN = "Not logged in. Run `codex` to authenticate."
  const ERR_SESSION_EXPIRED = "Session expired. Run `codex` to log in again."
  const ERR_TOKEN_CONFLICT = "Token conflict. Run `codex` to log in again."
  const ERR_TOKEN_REVOKED = "Token revoked. Run `codex` to log in again."
  const ERR_TOKEN_EXPIRED = "Token expired. Run `codex` to log in again."
  const ERR_AUTH_SAVE = "Could not save refreshed credentials. Try again; if the problem continues, run `codex` to log in again."
  const ERR_USAGE_API_KEY = "Usage not available for API key."
  const ERR_USAGE_CONNECTION = "Usage request failed. Check your connection."
  const ERR_USAGE_AFTER_REFRESH = "Usage request failed after refresh. Try again."

  function joinPath(base, leaf) {
    return base.replace(/[\\/]+$/, "") + "/" + leaf
  }

  function isWindows(ctx) {
    return !!(ctx.app && ctx.app.platform === "windows")
  }

  function rawDigest(ctx, text) {
    return ctx.host.crypto.sha256Hex(String(text))
  }

  function readCodexHome(ctx) {
    if (!ctx.host.env || typeof ctx.host.env.get !== "function") {
      return null
    }

    try {
      const value = ctx.host.env.get("CODEX_HOME")
      if (typeof value !== "string") return null
      const trimmed = value.trim()
      return trimmed || null
    } catch (e) {
      ctx.host.log.warn("CODEX_HOME read failed: " + String(e))
      return null
    }
  }

  function decodeHexUtf8(hex) {
    try {
      const bytes = []
      for (let i = 0; i < hex.length; i += 2) {
        bytes.push(parseInt(hex.slice(i, i + 2), 16))
      }

      if (typeof TextDecoder !== "undefined") {
        try {
          return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes))
        } catch {}
      }

      let escaped = ""
      for (const b of bytes) {
        const h = b.toString(16)
        escaped += "%" + (h.length === 1 ? "0" + h : h)
      }
      return decodeURIComponent(escaped)
    } catch {
      return null
    }
  }

  function tryParseAuthJson(ctx, text) {
    if (!text) return null
    const parsed = ctx.util.tryParseJson(text)
    if (parsed) return parsed

    // Some keychain payloads can be returned as hex-encoded UTF-8 bytes.
    let hex = String(text).trim()
    if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2)
    if (!hex || hex.length % 2 !== 0) return null
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null

    const decoded = decodeHexUtf8(hex)
    if (!decoded) return null
    return ctx.util.tryParseJson(decoded)
  }

  function resolveAuthPaths(ctx) {
    const codexHome = readCodexHome(ctx)

    // If CODEX_HOME is set, use it
    if (codexHome) {
      return [joinPath(codexHome, AUTH_FILE)]
    }

    const authPaths = isWindows(ctx) ? ["~/.codex"] : CONFIG_AUTH_PATHS
    return authPaths.map((basePath) => joinPath(basePath, AUTH_FILE))
  }

  function hasTokenLikeAuth(auth) {
    if (!auth || typeof auth !== "object") return false
    if (auth.tokens && auth.tokens.access_token) return true
    if (auth.OPENAI_API_KEY) return true
    return false
  }

  function hasAccessTokenAuth(auth) {
    return !!(auth && auth.tokens && auth.tokens.access_token)
  }

  function isAuthFallbackError(e) {
    if (typeof e !== "string") return false
    return (
      e === ERR_SESSION_EXPIRED ||
      e === ERR_TOKEN_CONFLICT ||
      e === ERR_TOKEN_REVOKED ||
      e === ERR_TOKEN_EXPIRED
    )
  }

  function loadAuthFromKeychain(ctx) {
    if (isWindows(ctx)) return null
    if (!ctx.host.keychain || typeof ctx.host.keychain.readGenericPassword !== "function") {
      return null
    }

    try {
      const value = ctx.host.keychain.readGenericPassword(KEYCHAIN_SERVICE)
      if (!value) return null
      const auth = tryParseAuthJson(ctx, value)
      if (!hasTokenLikeAuth(auth)) {
        ctx.host.log.warn("keychain has data but no codex auth payload")
        return null
      }
      ctx.host.log.info("auth loaded from keychain: " + KEYCHAIN_SERVICE)
      return { auth, authPath: null, source: "keychain" }
    } catch (e) {
      ctx.host.log.info("keychain read failed (may not exist): " + String(e))
      return null
    }
  }

  function saveAuth(ctx, authState) {
    const auth = authState && authState.auth ? authState.auth : null
    if (!auth) return false

    if (authState.source === "file" && authState.authPath) {
      const serialized = JSON.stringify(auth, null, 2)
      const persisted = ctx.host.fs.writeTextIfUnchanged(
        authState.authPath,
        serialized,
        authState.rawDigest
      )
      if (!persisted) {
        throw ERR_TOKEN_CONFLICT
      }
      authState.rawDigest = rawDigest(ctx, serialized)
      return true
    }

    if (authState.source === "keychain") {
      if (!ctx.host.keychain || typeof ctx.host.keychain.writeGenericPassword !== "function") {
        ctx.host.log.warn("keychain write unsupported in this host")
        return false
      }
      // Use compact JSON to avoid newline-induced keychain encoding issues.
      ctx.host.keychain.writeGenericPassword(KEYCHAIN_SERVICE, JSON.stringify(auth))
      return true
    }

    return false
  }

  function loadFileAuthCandidates(ctx) {
    const authPaths = resolveAuthPaths(ctx)
    const candidates = []
    const missingPaths = []
    for (const authPath of authPaths) {
      if (!ctx.host.fs.exists(authPath)) {
        missingPaths.push(authPath)
        continue
      }
      try {
        const text = ctx.host.fs.readText(authPath)
        const auth = tryParseAuthJson(ctx, text)
        if (!hasTokenLikeAuth(auth)) {
          ctx.host.log.warn("auth file exists but no valid codex auth payload: " + authPath)
          continue
        }
        ctx.host.log.info("auth loaded from file: " + authPath)
        candidates.push({ auth, authPath, source: "file", rawDigest: rawDigest(ctx, text) })
      } catch (e) {
        ctx.host.log.warn("auth file read failed: " + authPath + ": " + String(e))
      }
    }

    return { candidates, missingPaths }
  }

  function needsRefresh(ctx, auth, nowMs) {
    const accessToken = auth.tokens && auth.tokens.access_token
    if (accessToken && ctx.jwt && typeof ctx.jwt.decodePayload === "function") {
      const payload = ctx.jwt.decodePayload(accessToken)
      const expiresAtSeconds = payload && payload.exp
      if (typeof expiresAtSeconds === "number" && Number.isFinite(expiresAtSeconds)) {
        const expiresAtMs = expiresAtSeconds * 1000
        return expiresAtMs <= nowMs + ACCESS_TOKEN_REFRESH_WINDOW_MS
      }
    }

    if (!auth.last_refresh) return false
    const lastMs = ctx.util.parseDateMs(auth.last_refresh)
    if (lastMs === null) return false
    return nowMs - lastMs > REFRESH_AGE_MS
  }

  function reloadAuthState(ctx, authState) {
    let reloaded = null
    if (authState.source === "file" && authState.authPath) {
      try {
        const text = ctx.host.fs.readText(authState.authPath)
        const auth = tryParseAuthJson(ctx, text)
        if (hasTokenLikeAuth(auth)) {
          reloaded = {
            auth,
            authPath: authState.authPath,
            source: "file",
            rawDigest: rawDigest(ctx, text),
          }
        }
      } catch (e) {
        ctx.host.log.warn("auth reload failed for file " + authState.authPath + ": " + String(e))
      }
    } else if (authState.source === "keychain") {
      reloaded = loadAuthFromKeychain(ctx)
    }

    if (!reloaded) return { status: "unchanged", authState }
    if (!hasAccessTokenAuth(reloaded.auth)) {
      return { status: "error", error: ERR_TOKEN_CONFLICT }
    }

    const expectedAccountId = authState.auth.tokens && authState.auth.tokens.account_id
    const reloadedAccountId = reloaded.auth.tokens && reloaded.auth.tokens.account_id
    if (expectedAccountId && reloadedAccountId !== expectedAccountId) {
      return { status: "error", error: ERR_TOKEN_CONFLICT }
    }

    const fileChanged = authState.source === "file" && reloaded.rawDigest !== authState.rawDigest
    if (fileChanged || JSON.stringify(reloaded.auth) !== JSON.stringify(authState.auth)) {
      ctx.host.log.info("auth changed during guarded reload, using updated credentials")
      return { status: "changed", authState: reloaded }
    }
    return { status: "unchanged", authState }
  }

  function mergeRefreshResponse(auth, body) {
    const updatedAuth = JSON.parse(JSON.stringify(auth))
    updatedAuth.tokens.access_token = body.access_token
    if (body.refresh_token) updatedAuth.tokens.refresh_token = body.refresh_token
    if (body.id_token) updatedAuth.tokens.id_token = body.id_token
    updatedAuth.last_refresh = new Date().toISOString()
    return updatedAuth
  }

  function persistRefreshedAuth(ctx, authState, usedRefreshToken, body) {
    let currentState = authState
    const refreshTokenRotated = !!body.refresh_token && body.refresh_token !== usedRefreshToken

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const currentRefreshToken = currentState.auth.tokens && currentState.auth.tokens.refresh_token
      if (currentRefreshToken !== usedRefreshToken) throw ERR_TOKEN_CONFLICT

      const updatedAuth = mergeRefreshResponse(currentState.auth, body)
      const updatedState = Object.assign({}, currentState, { auth: updatedAuth })

      try {
        if (!saveAuth(ctx, updatedState)) throw ERR_AUTH_SAVE
        authState.auth = updatedAuth
        authState.rawDigest = updatedState.rawDigest
        return true
      } catch (e) {
        if (attempt === 1 || e === ERR_AUTH_SAVE || !refreshTokenRotated) throw e
        const reload = reloadAuthState(ctx, currentState)
        if (reload.status === "error") throw reload.error
        currentState = reload.authState
        ctx.host.log.warn("refresh persistence changed or was temporarily unavailable, retrying once")
      }
    }

    return false
  }

  function refreshToken(ctx, authState) {
    const auth = authState.auth
    if (!auth.tokens || !auth.tokens.refresh_token) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting token refresh")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" + encodeURIComponent(CLIENT_ID) +
          "&refresh_token=" + encodeURIComponent(auth.tokens.refresh_token),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401) {
        let code = null
        const body = ctx.util.tryParseJson(resp.bodyText)
        if (body) {
          code = body.error?.code || body.error || body.code
        }
        ctx.host.log.error("refresh failed: status=" + resp.status + " code=" + String(code))
        if (code === "refresh_token_expired") {
          throw ERR_SESSION_EXPIRED
        }
        if (code === "refresh_token_reused") {
          throw ERR_TOKEN_CONFLICT
        }
        if (code === "refresh_token_invalidated") {
          throw ERR_TOKEN_REVOKED
        }
        throw ERR_TOKEN_EXPIRED
      }
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("refresh returned unexpected status: " + resp.status)
        return null
      }

      const body = ctx.util.tryParseJson(resp.bodyText)
      if (!body) {
        ctx.host.log.warn("refresh response not valid JSON")
        return null
      }
      const newAccessToken = body.access_token
      if (!newAccessToken) {
        ctx.host.log.warn("refresh response missing access_token")
        return null
      }

      let saved = false
      try {
        saved = persistRefreshedAuth(ctx, authState, auth.tokens.refresh_token, body)
        if (saved) {
          ctx.host.log.info("refresh succeeded, auth persisted to " + authState.source)
        }
      } catch (e) {
        if (e === ERR_TOKEN_CONFLICT) throw e
        ctx.host.log.error("refresh succeeded but failed to save auth: " + String(e))
        throw ERR_AUTH_SAVE
      }
      if (!saved) {
        ctx.host.log.error("refresh succeeded but auth persistence was not available")
        throw ERR_AUTH_SAVE
      }

      return newAccessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }
  }

  function fetchUsage(ctx, accessToken, accountId) {
    const headers = {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "User-Agent": "OpenUsageCN",
    }
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId
    }
    return ctx.util.request({
      method: "GET",
      url: USAGE_URL,
      headers,
      timeoutMs: 10000,
    })
  }

  function fetchResetCreditInventory(ctx, accessToken, accountId, nowMs) {
    const headers = {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "User-Agent": "OpenUsageCN",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    }
    if (accountId) {
      headers["ChatGPT-Account-ID"] = accountId
    }

    try {
      const resp = ctx.util.request({
        method: "GET",
        url: RATE_LIMIT_RESET_CREDITS_URL,
        headers,
        timeoutMs: 4000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.error("rate limit reset credits returned error: status=" + resp.status)
        return null
      }

      const data = ctx.util.tryParseJson(resp.bodyText)
      if (!data || !Array.isArray(data.credits)) {
        ctx.host.log.error("rate limit reset credits response invalid")
        return null
      }

      let nextExpiryMs = null
      let derivedAvailableCount = 0
      for (let i = 0; i < data.credits.length; i++) {
        const credit = data.credits[i]
        if (!credit || credit.status !== "available") continue
        if (credit.expires_at == null) {
          derivedAvailableCount++
          continue
        }
        const expiresAtMs = Date.parse(credit.expires_at)
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue
        derivedAvailableCount++
        if (nextExpiryMs === null || expiresAtMs < nextExpiryMs) {
          nextExpiryMs = expiresAtMs
        }
      }

      const responseAvailableCount = data.available_count != null
        ? readNumber(data.available_count)
        : null
      const availableCount = responseAvailableCount !== null && responseAvailableCount >= 0
        ? Math.floor(responseAvailableCount)
        : derivedAvailableCount
      if (availableCount > 0 && nextExpiryMs === null) {
        ctx.host.log.warn("rate limit reset credits has no unexpired available card")
      }
      return { availableCount, nextExpiryMs }
    } catch (e) {
      ctx.host.log.error("rate limit reset credits request failed: " + String(e))
      return null
    }
  }

  function readPercent(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function readNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function readCreditsRemaining(resp, data) {
    const credits = data && data.credits && typeof data.credits === "object" ? data.credits : null
    if (credits) {
      const bodyBalance = readNumber(credits.balance)
      if (bodyBalance !== null) return bodyBalance
      if (credits.has_credits === false) return 0
    }

    return readNumber(resp.headers["x-codex-credits-balance"])
  }

  function formatCodexPlan(ctx, planType) {
    const rawPlan = typeof planType === "string" ? planType.trim() : ""
    if (!rawPlan) return null
    const normalizedPlan = rawPlan.toLowerCase()
    if (["prolite", "pro_lite", "pro-lite"].includes(normalizedPlan)) return "Pro 5x"
    if (normalizedPlan === "pro") return "Pro 20x"
    return ctx.fmt.planLabel(rawPlan) || null
  }

  function getResetsAtIso(ctx, nowSec, window) {
    if (!window) return null
    if (typeof window.reset_at === "number") {
      return ctx.util.toIso(window.reset_at)
    }
    if (typeof window.reset_after_seconds === "number") {
      return ctx.util.toIso(nowSec + window.reset_after_seconds)
    }
    return null
  }

  // Period durations in milliseconds
  var PERIOD_SESSION_MS = 5 * 60 * 60 * 1000    // 5 hours
  var PERIOD_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  function getRateLimitWindowKind(window, fallbackKind) {
    if (!window || typeof window.limit_window_seconds !== "number") return fallbackKind
    if (window.limit_window_seconds * 1000 === PERIOD_SESSION_MS) return "session"
    if (window.limit_window_seconds * 1000 === PERIOD_WEEKLY_MS) return "weekly"
    return fallbackKind
  }

  function queryTokenUsage(ctx) {
    if (isWindows(ctx)) {
      return { status: "no_runner", data: null }
    }
    if (!ctx.host.ccusage || typeof ctx.host.ccusage.query !== "function") {
      return { status: "no_runner", data: null }
    }

    const since = new Date()
    // Inclusive range: today + previous 30 days = 31 calendar days.
    since.setDate(since.getDate() - 30)
    const y = since.getFullYear()
    const m = since.getMonth() + 1
    const d = since.getDate()
    const sinceStr = "" + y + (m < 10 ? "0" : "") + m + (d < 10 ? "0" : "") + d
    const queryOpts = { provider: "codex", since: sinceStr }
    const codexHome = readCodexHome(ctx)
    if (codexHome) {
      queryOpts.homePath = codexHome
    }

    const result = ctx.host.ccusage.query(queryOpts)
    if (!result || typeof result !== "object" || typeof result.status !== "string") {
      return { status: "runner_failed", data: null }
    }
    if (result.status !== "ok") {
      return { status: result.status, data: null }
    }
    if (!result.data || !Array.isArray(result.data.daily)) {
      return { status: "runner_failed", data: null }
    }
    return { status: "ok", data: result.data }
  }

  function fmtTokens(n) {
    const abs = Math.abs(n)
    const sign = n < 0 ? "-" : ""
    if (abs >= 1e7) return sign + (abs / 1e8).toFixed(1) + "亿"
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(1) + "万"
    return sign + abs.toFixed(1)
  }

  function resetCreditExpiryText(remainingMs) {
    const hourMs = 60 * 60 * 1000
    if (remainingMs < hourMs) return "<1小时"
    const totalHours = Math.floor(remainingMs / hourMs)
    if (totalHours < 24) return totalHours + "小时"
    const days = Math.floor(totalHours / 24)
    const hours = totalHours % 24
    return days + "天" + (hours > 0 ? hours + "时" : "")
  }

  function dayKeyFromDate(date) {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
  }

  function dayKeyFromUsageDate(rawDate) {
    if (typeof rawDate !== "string") return null
    const value = rawDate.trim()
    if (!value) return null

    const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoMatch) {
      return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3]
    }

    const isoDatePrefixMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt\s]|$)/)
    if (isoDatePrefixMatch) {
      return isoDatePrefixMatch[1] + "-" + isoDatePrefixMatch[2] + "-" + isoDatePrefixMatch[3]
    }

    const compactMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (compactMatch) {
      return compactMatch[1] + "-" + compactMatch[2] + "-" + compactMatch[3]
    }

    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) return null
    return dayKeyFromDate(new Date(ms))
  }

  function usageCostUsd(day) {
    if (!day || typeof day !== "object") return null

    if (day.totalCost != null) {
      const totalCost = Number(day.totalCost)
      if (Number.isFinite(totalCost)) return totalCost
    }

    if (day.costUSD != null) {
      const costUSD = Number(day.costUSD)
      if (Number.isFinite(costUSD)) return costUSD
    }

    return null
  }

  function costAndTokensLabel(data, opts) {
    const includeZeroTokens = !!(opts && opts.includeZeroTokens)
    const parts = []
    if (data.costUSD != null) parts.push("$" + data.costUSD.toFixed(2))
    if (data.tokens > 0 || (includeZeroTokens && data.tokens === 0)) {
      parts.push(fmtTokens(data.tokens) + " tokens")
    }
    return parts.join(" · ")
  }

  function modelTokenCount(modelUsage) {
    if (!modelUsage || typeof modelUsage !== "object") return 0
    const total = Number(modelUsage.totalTokens)
    if (Number.isFinite(total) && total > 0) return total

    const fields = [
      "inputTokens",
      "cachedInputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ]
    let sum = 0
    for (let i = 0; i < fields.length; i++) {
      const n = Number(modelUsage[fields[i]])
      if (Number.isFinite(n) && n > 0) sum += n
    }
    return sum
  }

  function collectModelUsage(daily) {
    const totals = {}
    let totalTokens = 0
    for (let i = 0; i < daily.length; i++) {
      const day = daily[i]
      const models = day && day.models
      if (models && typeof models === "object") {
        const names = Object.keys(models)
        for (let j = 0; j < names.length; j++) {
          const name = names[j]
          const tokens = modelTokenCount(models[name])
          if (tokens <= 0) continue
          totals[name] = (totals[name] || 0) + tokens
          totalTokens += tokens
        }
      }

      const breakdowns = day && day.modelBreakdowns
      if (Array.isArray(breakdowns)) {
        for (let j = 0; j < breakdowns.length; j++) {
          const breakdown = breakdowns[j]
          const name = String(
            (breakdown && (breakdown.modelName || breakdown.name || breakdown.model)) || ""
          ).trim()
          if (!name) continue
          const tokens = modelTokenCount(breakdown)
          if (tokens <= 0) continue
          totals[name] = (totals[name] || 0) + tokens
          totalTokens += tokens
        }
      }
    }

    if (totalTokens <= 0) return []
    return Object.keys(totals)
      .map((name) => ({ name, tokens: totals[name], percent: (totals[name] / totalTokens) * 100 }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
  }

  function percentLabel(value) {
    if (value > 0 && value < 0.1) return "<0.1%"
    const rounded = Math.round(value * 10) / 10
    return (rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded)) + "%"
  }

  function pushModelUsageLines(lines, ctx, daily) {
    const models = collectModelUsage(daily)
    for (let i = 0; i < models.length; i++) {
      const model = models[i]
      lines.push(ctx.line.text({
        label: model.name,
        value: percentLabel(model.percent),
      }))
    }
  }

  function usageDayLabel(rawDate) {
    const key = dayKeyFromUsageDate(rawDate)
    if (!key) return String(rawDate || "").slice(0, 10) || "Usage"
    const month = Number(key.slice(5, 7))
    const day = Number(key.slice(8, 10))
    return month + "/" + day
  }

  function collectUsageChartPoints(daily) {
    const points = []
    for (let i = 0; i < daily.length; i++) {
      const day = daily[i]
      const tokens = Number(day && day.totalTokens)
      if (!Number.isFinite(tokens) || tokens < 0) continue
      const key = dayKeyFromUsageDate(day.date)
      if (!key) continue
      points.push({
        key: key,
        label: usageDayLabel(day.date),
        value: tokens,
        valueLabel: fmtTokens(tokens) + " tokens",
      })
    }
    return points
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-31)
      .map((point) => ({
        label: point.label,
        value: point.value,
        valueLabel: point.valueLabel,
      }))
  }

  function pushUsageChartLine(lines, ctx, daily) {
    const points = collectUsageChartPoints(daily)
    if (points.length === 0) return
    lines.push(ctx.line.barChart({
      label: "用量趋势",
      points: points,
      note: "根据所选账号的本地 Codex 日志估算。",
      color: "#74AA9C",
    }))
  }

  function pushDayUsageLine(lines, ctx, label, dayEntry) {
    const tokens = Number(dayEntry && dayEntry.totalTokens) || 0
    const cost = usageCostUsd(dayEntry)
    if (tokens > 0) {
      lines.push(ctx.line.text({
        label: label,
        value: costAndTokensLabel({ tokens: tokens, costUSD: cost })
      }))
      return
    }

    lines.push(ctx.line.text({
      label: label,
      value: costAndTokensLabel({ tokens: 0, costUSD: 0 }, { includeZeroTokens: true })
    }))
  }

  function probeWithAuthState(ctx, initialAuthState) {
    let authState = initialAuthState
    let auth = authState.auth

    if (auth.tokens && auth.tokens.access_token) {
      const nowMs = Date.now()
      let accessToken = auth.tokens.access_token
      let accountId = auth.tokens.account_id
      let proactiveRefreshAuthError = null

      if (needsRefresh(ctx, auth, nowMs)) {
        ctx.host.log.info("token needs refresh")
        const reload = reloadAuthState(ctx, authState)
        if (reload.status === "error") throw reload.error
        authState = reload.authState
        auth = authState.auth
        accessToken = auth.tokens.access_token
        accountId = auth.tokens.account_id
        let refreshed = null
        if (needsRefresh(ctx, auth, nowMs)) {
          try {
            refreshed = refreshToken(ctx, authState)
          } catch (e) {
            if (!isAuthFallbackError(e)) throw e
            proactiveRefreshAuthError = e
            ctx.host.log.warn("proactive refresh failed, trying existing token: " + String(e))
          }
        }
        if (refreshed) {
          accessToken = refreshed
        } else if (!proactiveRefreshAuthError) {
          ctx.host.log.warn("proactive refresh failed, trying with existing token")
        }
      }

      let resp
      let didRefresh = false
      let didReloadAuth = false
      try {
        resp = ctx.util.retryOnceOnAuth({
          request: (token) => {
            try {
              return fetchUsage(ctx, token || accessToken, accountId)
            } catch (e) {
              ctx.host.log.error("usage request exception: " + String(e))
              if (didRefresh) {
                throw ERR_USAGE_AFTER_REFRESH
              }
              throw ERR_USAGE_CONNECTION
            }
          },
          refresh: () => {
            const reload = reloadAuthState(ctx, authState)
            if (reload.status === "error") throw reload.error
            if (reload.status === "changed") {
              authState = reload.authState
              auth = authState.auth
              accessToken = auth.tokens.access_token
              accountId = auth.tokens.account_id
              proactiveRefreshAuthError = null
              didReloadAuth = true
              ctx.host.log.info("usage returned 401, retrying with reloaded auth")
              return accessToken
            }
            if (proactiveRefreshAuthError) throw proactiveRefreshAuthError
            ctx.host.log.info("usage returned 401, attempting refresh")
            didRefresh = true
            const refreshed = refreshToken(ctx, authState)
            if (refreshed) accessToken = refreshed
            return refreshed
          },
        })
      } catch (e) {
        if (typeof e === "string") throw e
        ctx.host.log.error("usage request failed: " + String(e))
        throw ERR_USAGE_CONNECTION
      }

      if (didReloadAuth && ctx.util.isAuthStatus(resp.status)) {
        ctx.host.log.info("reloaded auth returned 401, attempting refresh")
        didRefresh = true
        const refreshed = refreshToken(ctx, authState)
        if (refreshed) {
          accessToken = refreshed
          try {
            resp = fetchUsage(ctx, refreshed, accountId)
          } catch (e) {
            ctx.host.log.error("usage request exception after reloaded auth refresh: " + String(e))
            throw ERR_USAGE_AFTER_REFRESH
          }
        }
      }

      if (ctx.util.isAuthStatus(resp.status)) {
        ctx.host.log.error("usage returned auth error after all retries: status=" + resp.status)
        throw ERR_TOKEN_EXPIRED
      }

      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.error("usage returned error: status=" + resp.status)
        throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
      }

      ctx.host.log.info("usage fetch succeeded")

      const data = ctx.util.tryParseJson(resp.bodyText)
      if (data === null) {
        throw "Usage response invalid. Try again later."
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

      const rateLimitWindows = [
        {
          kind: getRateLimitWindowKind(primaryWindow, "session"),
          window: primaryWindow,
          headerUsed: headerPrimary,
          bodyUsed: primaryWindow && typeof primaryWindow.used_percent === "number"
            ? primaryWindow.used_percent
            : null
        },
        {
          kind: getRateLimitWindowKind(secondaryWindow, "weekly"),
          window: secondaryWindow,
          headerUsed: headerSecondary,
          bodyUsed: secondaryWindow && typeof secondaryWindow.used_percent === "number"
            ? secondaryWindow.used_percent
            : null
        }
      ]

      for (const kind of ["session", "weekly"]) {
        const entry = rateLimitWindows.find((candidate) =>
          candidate.kind === kind && (candidate.headerUsed !== null || candidate.bodyUsed !== null)
        )
        if (!entry) continue
        lines.push(ctx.line.progress({
          label: kind === "session" ? "5小时" : "每周",
          limitResourceKey: kind,
          used: entry.headerUsed !== null ? entry.headerUsed : entry.bodyUsed,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: getResetsAtIso(ctx, nowSec, entry.window),
          periodDurationMs: kind === "session" ? PERIOD_SESSION_MS : PERIOD_WEEKLY_MS
        }))
      }

      if (Array.isArray(data.additional_rate_limits)) {
        for (const entry of data.additional_rate_limits) {
          if (!entry || !entry.rate_limit) continue
          const name = typeof entry.limit_name === "string" ? entry.limit_name : ""
          let shortName = name.replace(/^GPT-[\d.]+-Codex-/, "")
          if (!shortName) shortName = name || "Model"
          const limitResourceKey = entry.metered_feature === "codex_bengalfox" ? "spark" : null
          const rl = entry.rate_limit
          if (rl.primary_window && typeof rl.primary_window.used_percent === "number") {
            lines.push(ctx.line.progress({
              label: shortName,
              limitResourceKey: limitResourceKey,
              used: rl.primary_window.used_percent,
              limit: 100,
              format: { kind: "percent" },
              resetsAt: getResetsAtIso(ctx, nowSec, rl.primary_window),
              periodDurationMs: typeof rl.primary_window.limit_window_seconds === "number"
                ? rl.primary_window.limit_window_seconds * 1000
                : PERIOD_SESSION_MS
            }))
          }
          if (rl.secondary_window && typeof rl.secondary_window.used_percent === "number") {
            lines.push(ctx.line.progress({
              label: shortName + " 每周",
              limitResourceKey: limitResourceKey ? limitResourceKey + "Weekly" : null,
              used: rl.secondary_window.used_percent,
              limit: 100,
              format: { kind: "percent" },
              resetsAt: getResetsAtIso(ctx, nowSec, rl.secondary_window),
              periodDurationMs: typeof rl.secondary_window.limit_window_seconds === "number"
                ? rl.secondary_window.limit_window_seconds * 1000
                : PERIOD_WEEKLY_MS
            }))
          }
        }
      }

      if (reviewWindow) {
        const used = reviewWindow.used_percent
        if (typeof used === "number") {
          lines.push(ctx.line.progress({
            label: "代码审查",
            limitResourceKey: "codeReview",
            used: used,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: getResetsAtIso(ctx, nowSec, reviewWindow),
            periodDurationMs: PERIOD_WEEKLY_MS // code_review_rate_limit is a 7-day window
          }))
        }
      }

      const resetCredits =
        data.rate_limit_reset_credits &&
        typeof data.rate_limit_reset_credits === "object" &&
        data.rate_limit_reset_credits.available_count != null
          ? readNumber(data.rate_limit_reset_credits.available_count)
          : null
      if (resetCredits !== null && resetCredits >= 0) {
        let count = Math.floor(resetCredits)
        const resetInventory = count > 0
          ? fetchResetCreditInventory(ctx, accessToken, accountId, nowMs)
          : null
        if (resetInventory !== null) {
          count = resetInventory.availableCount
        }
        const resetLine = {
          label: "手动重置",
          value: count + " 次可用",
        }
        if (count > 0) {
          const nextExpiryMs = resetInventory && resetInventory.nextExpiryMs
          if (!nextExpiryMs) {
            resetLine.subtitle = "· 下一个到期未知"
          } else {
            const remainingMs = nextExpiryMs - nowMs
            const expirySpacing = remainingMs >= 24 * 60 * 60 * 1000 ? "" : " "
            resetLine.subtitle = "· 下一个" + expirySpacing + resetCreditExpiryText(remainingMs) + "后过期"
            if (remainingMs < 24 * 60 * 60 * 1000) {
              resetLine.color = "#f59e0b"
            }
          }
        }
        lines.push(ctx.line.text(resetLine))
      }

      const creditsRemaining = readCreditsRemaining(resp, data)
      if (creditsRemaining !== null) {
        const remaining = Math.max(0, Math.floor(creditsRemaining))
        const usdValue = (remaining * CREDIT_USD_RATE).toFixed(2)
        lines.push(ctx.line.text({
          label: "点数",
          value: "$" + usdValue + " · " + remaining + " 点数",
        }))
      }

      let plan = null
      if (data.plan_type) {
        const planLabel = formatCodexPlan(ctx, data.plan_type)
        if (planLabel) {
          plan = planLabel
        }
      }

      const tokenUsageResult = queryTokenUsage(ctx)
      if (tokenUsageResult.status === "ok") {
        const tokenUsage = tokenUsageResult.data
        const now = new Date()
        const todayKey = dayKeyFromDate(now)
        const yesterday = new Date(now.getTime())
        yesterday.setDate(yesterday.getDate() - 1)
        const yesterdayKey = dayKeyFromDate(yesterday)

        let todayEntry = null
        let yesterdayEntry = null
        for (let i = 0; i < tokenUsage.daily.length; i++) {
          const usageDayKey = dayKeyFromUsageDate(tokenUsage.daily[i].date)
          if (usageDayKey === todayKey) {
            todayEntry = tokenUsage.daily[i]
            continue
          }
          if (usageDayKey === yesterdayKey) {
            yesterdayEntry = tokenUsage.daily[i]
          }
        }

        pushDayUsageLine(lines, ctx, "今日", todayEntry)
        pushDayUsageLine(lines, ctx, "昨日", yesterdayEntry)

        let totalTokens = 0
        let totalCostNanos = 0
        let hasCost = false
        for (let i = 0; i < tokenUsage.daily.length; i++) {
          const day = tokenUsage.daily[i]
          const dayTokens = Number(day.totalTokens)
          if (Number.isFinite(dayTokens)) {
            totalTokens += dayTokens
          }

          const dayCost = usageCostUsd(day)
          if (dayCost != null) {
            totalCostNanos += Math.round(dayCost * 1e9)
            hasCost = true
          }
        }

        if (totalTokens > 0) {
          lines.push(ctx.line.text({
            label: "近30天",
            value: costAndTokensLabel({ tokens: totalTokens, costUSD: hasCost ? totalCostNanos / 1e9 : null })
          }))
        }

        pushUsageChartLine(lines, ctx, tokenUsage.daily)
        pushModelUsageLines(lines, ctx, tokenUsage.daily)
      }

      if (lines.length === 0) {
        lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
      }

      return { plan: plan, lines: lines }
    }

    if (auth.OPENAI_API_KEY) {
      throw ERR_USAGE_API_KEY
    }

    throw ERR_NOT_LOGGED_IN
  }

  function probe(ctx) {
    const fileAuth = loadFileAuthCandidates(ctx)
    let lastAuthFallbackError = null
    for (let i = 0; i < fileAuth.candidates.length; i++) {
      const authState = fileAuth.candidates[i]
      try {
        return probeWithAuthState(ctx, authState)
      } catch (e) {
        if (!isAuthFallbackError(e)) {
          throw e
        }
        lastAuthFallbackError = e
        ctx.host.log.warn("auth failed for file " + authState.authPath + ", trying next auth source: " + String(e))
      }
    }

    const keychainAuth = loadAuthFromKeychain(ctx)
    if (keychainAuth) {
      try {
        return probeWithAuthState(ctx, keychainAuth)
      } catch (e) {
        if (!isAuthFallbackError(e)) throw e
        lastAuthFallbackError = e
        ctx.host.log.warn("keychain auth failed: " + String(e))
      }
    }

    if (lastAuthFallbackError) throw lastAuthFallbackError

    for (const authPath of fileAuth.missingPaths) {
      ctx.host.log.warn("auth file not found: " + authPath)
    }

    ctx.host.log.error("probe failed: not logged in")
    throw ERR_NOT_LOGGED_IN
  }

  globalThis.__openusage_plugin = { id: "codex", probe }
})()
