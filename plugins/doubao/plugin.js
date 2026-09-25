(function () {
  const API = "https://open.volcengineapi.com/?Action="
  const VERSION = "&Version=2024-01-01"
  const CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8"
  const SIGNED_HEADERS = "content-type;host;x-content-sha256;x-date"

  function setting(ctx, key, env) {
    const configured = ctx.host.config.get(key)
    if (typeof configured === "string" && configured.trim()) return configured.trim()
    const fallback = ctx.host.env.get(env)
    return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null
  }

  function signature(ctx, secret, date, region, stringToSign) {
    const crypto = ctx.host.crypto
    const dateKey = crypto.hmacSha256Hex(secret, date, false)
    const regionKey = crypto.hmacSha256Hex(dateKey, region, true)
    const serviceKey = crypto.hmacSha256Hex(regionKey, "ark", true)
    const signingKey = crypto.hmacSha256Hex(serviceKey, "request", true)
    return crypto.hmacSha256Hex(signingKey, stringToSign, true)
  }

  function signedRequest(ctx, action, credentials) {
    const instant = new Date(ctx.nowIso)
    const now = Number.isFinite(instant.getTime()) ? instant : new Date()
    const timestamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z"
    const date = timestamp.slice(0, 8)
    const payloadHash = ctx.host.crypto.sha256Hex("")
    const canonicalQuery = "Action=" + action + VERSION
    const canonicalRequest = [
      "POST", "/", canonicalQuery,
      "content-type:" + CONTENT_TYPE,
      "host:open.volcengineapi.com",
      "x-content-sha256:" + payloadHash,
      "x-date:" + timestamp,
      "", SIGNED_HEADERS, payloadHash,
    ].join("\n")
    const scope = date + "/" + credentials.region + "/ark/request"
    const stringToSign = [
      "HMAC-SHA256", timestamp, scope, ctx.host.crypto.sha256Hex(canonicalRequest),
    ].join("\n")
    const signed = signature(ctx, credentials.secret, date, credentials.region, stringToSign)
    const authorization = "HMAC-SHA256 Credential=" + credentials.access + "/" + scope +
      ", SignedHeaders=" + SIGNED_HEADERS + ", Signature=" + signed
    let response
    try {
      response = ctx.host.http.request({
        method: "POST", url: API + action + VERSION, bodyText: "", timeoutMs: 15000,
        headers: {
          Accept: "application/json", Authorization: authorization,
          "Content-Type": CONTENT_TYPE, Host: "open.volcengineapi.com",
          "X-Content-Sha256": payloadHash, "X-Date": timestamp,
        },
      })
    } catch (error) {
      ctx.host.log.error("Doubao " + action + " network request failed")
      throw "Doubao usage request failed. Check your connection."
    }
    if (response.status < 200 || response.status >= 300) {
      ctx.host.log.error("Doubao " + action + " returned HTTP " + response.status)
      throw "Doubao usage request failed (HTTP " + response.status + "). Check your Volcengine key and permissions."
    }
    let data
    try {
      data = JSON.parse(response.bodyText)
    } catch (error) {
      ctx.host.log.error("Doubao " + action + " returned invalid JSON")
      throw "Doubao usage response invalid. Try again later."
    }
    if (!data || typeof data !== "object" || !data.Result || typeof data.Result !== "object") {
      const code = data && data.ResponseMetadata && data.ResponseMetadata.Error && data.ResponseMetadata.Error.Code
      ctx.host.log.error("Doubao " + action + " returned an API error" + (typeof code === "string" ? " (" + code + ")" : ""))
      throw "Doubao usage unavailable. Check your Volcengine key and plan access."
    }
    return data.Result
  }

  function resetIso(raw, milliseconds) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null
    const date = new Date(milliseconds ? raw : raw * 1000)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }

  function quotaLine(ctx, label, key, percent, reset, duration) {
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      throw new Error("invalid quota percentage")
    }
    return ctx.line.progress({
      label, used: Math.min(100, Math.max(0, percent)), limit: 100, format: { kind: "percent" },
      limitResourceKey: key, resetsAt: reset,
      periodDurationMs: reset ? duration : undefined,
    })
  }

  function codingLines(ctx, result) {
    const quotas = result.QuotaUsage
    if (quotas === undefined) return []
    if (!Array.isArray(quotas)) throw new Error("invalid Coding Plan quota list")
    const levels = {
      session: ["Coding Plan 5H", "codingSession", 5 * 60 * 60 * 1000],
      "5-hour": ["Coding Plan 5H", "codingSession", 5 * 60 * 60 * 1000],
      five_hour: ["Coding Plan 5H", "codingSession", 5 * 60 * 60 * 1000],
      "5h": ["Coding Plan 5H", "codingSession", 5 * 60 * 60 * 1000],
      weekly: ["Coding Plan Weekly", "codingWeekly", 7 * 24 * 60 * 60 * 1000],
      week: ["Coding Plan Weekly", "codingWeekly", 7 * 24 * 60 * 60 * 1000],
      monthly: ["Coding Plan Monthly", "codingMonthly", 30 * 24 * 60 * 60 * 1000],
      month: ["Coding Plan Monthly", "codingMonthly", 30 * 24 * 60 * 60 * 1000],
    }
    const seen = {}
    const lines = []
    for (const quota of quotas) {
      const descriptor = quota && levels[String(quota.Level).toLowerCase()]
      if (!descriptor || seen[descriptor[1]]) continue
      lines.push(quotaLine(ctx, descriptor[0], descriptor[1], quota.Percent,
        resetIso(quota.ResetTimestamp, false), descriptor[2]))
      seen[descriptor[1]] = true
    }
    return lines
  }

  function agentLines(ctx, result) {
    const windows = [
      ["AFPFiveHour", "Agent Plan 5H", "agentSession", 5 * 60 * 60 * 1000],
      ["AFPWeekly", "Agent Plan Weekly", "agentWeekly", 7 * 24 * 60 * 60 * 1000],
      ["AFPMonthly", "Agent Plan Monthly", "agentMonthly", 30 * 24 * 60 * 60 * 1000],
    ]
    const lines = []
    for (const [field, label, key, duration] of windows) {
      const window = result[field]
      if (!window) continue
      // The public API documents decimal strings; CodexBar's fixtures also contain numbers.
      const decimal = (value) => typeof value === "number" ? value :
        typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
      const quota = decimal(window.Quota)
      const used = decimal(window.Used)
      if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(used) || used < 0) {
        throw new Error("invalid Agent Plan quota")
      }
      lines.push(quotaLine(ctx, label, key, Math.min(100, used / quota * 100),
        resetIso(window.ResetTime, true), duration))
    }
    return lines
  }

  function probe(ctx) {
    const access = setting(ctx, "accessKeyId", "VOLCENGINE_ACCESS_KEY_ID")
    const secret = setting(ctx, "secretAccessKey", "VOLCENGINE_SECRET_ACCESS_KEY")
    const region = setting(ctx, "region", "VOLCENGINE_REGION") || "cn-beijing"
    if (!access || !secret) throw "No Volcengine AK/SK found. Add both keys in Doubao Settings or set VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY."
    if (!/^[A-Za-z0-9-]+$/.test(region)) throw "Invalid Volcengine region."
    const credentials = { access, secret, region }
    let lines
    try {
      lines = codingLines(ctx, signedRequest(ctx, "GetCodingPlanUsage", credentials))
    } catch (error) {
      if (String(error).startsWith("Doubao ")) throw error
      ctx.host.log.error("Doubao Coding Plan response invalid: " + String(error))
      throw "Doubao Coding Plan response invalid. Try again later."
    }
    try {
      lines.push(...agentLines(ctx, signedRequest(ctx, "GetAFPUsage", credentials)))
    } catch (error) {
      ctx.host.log.warn("Doubao Agent Plan usage unavailable: " + String(error))
      if (lines.length === 0) {
        if (String(error).startsWith("Doubao ")) throw error
        throw "Doubao Agent Plan response invalid. Try again later."
      }
    }
    if (lines.length === 0) {
      ctx.host.log.error("Doubao returned no active Coding Plan or Agent Plan quota")
      throw "No active Doubao Coding Plan or Agent Plan quota found."
    }
    return { plan: "Volcengine Ark", lines }
  }

  globalThis.__openusage_plugin = { id: "doubao", probe }
})()
