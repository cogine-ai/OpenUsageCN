(function () {
  const URL = "https://api.meta.ai/muse-code/key"

  function fail(ctx, reason, message) {
    ctx.host.log.error("Muse Code usage failed: " + reason)
    throw message
  }

  function invalid(ctx) {
    fail(ctx, "invalid response", "Muse Code usage response changed. Try again later.")
  }

  function reset(ctx, value) {
    if (value === null || value === undefined) return undefined
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value * 1000 > 8640000000000000) invalid(ctx)
    return new Date(value * 1000).toISOString()
  }

  function probe(ctx) {
    const configured = ctx.host.config.get("accessToken")
    const token = typeof configured === "string" ? configured.trim() : ""
    if (!token) fail(ctx, "missing connection", "Connect Muse Code with Meta to view usage.")
    if (!token.startsWith("dca:") || /[\x00-\x20\x7f]/.test(token)) {
      fail(ctx, "invalid access token", "Muse Code connection is invalid. Connect with Meta again.")
    }
    const expiry = ctx.host.config.get("tokenExpiresAt")
    if (expiry !== null && expiry !== undefined && expiry !== "") {
      if (typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(expiry) || !Number.isFinite(Date.parse(expiry))) {
        fail(ctx, "invalid token expiry", "Muse Code connection is invalid. Connect with Meta again.")
      }
      if (Date.parse(expiry) <= Date.parse(ctx.nowIso)) fail(ctx, "expired token", "Muse Code session expired. Connect with Meta again.")
    }
    let response
    try {
      response = ctx.util.request({
        method: "POST", url: URL,
        headers: {
          Authorization: "Bearer " + token, Accept: "application/json",
          "Content-Type": "application/json", "x-api-version": "1.0.0",
        },
        bodyText: '{"onboard":false}', timeoutMs: 15000,
      })
    } catch (_) {
      fail(ctx, "network request", "Muse Code request failed. Check your connection.")
    }
    if (response.status === 401) fail(ctx, "authentication rejected", "Muse Code session expired. Connect with Meta again.")
    if (response.status === 403) fail(ctx, "access denied", "Muse Code denied access to usage data.")
    if (response.status === 429) fail(ctx, "rate limited", "Muse Code requests are rate limited. Try again later.")
    if (response.status !== 200) fail(ctx, "HTTP " + response.status, "Muse Code usage request failed. Try again later.")
    const data = ctx.util.tryParseJson(response.bodyText)
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.is_subs_active !== "boolean") invalid(ctx)
    const plan = typeof data.subs_tier_name === "string" ? data.subs_tier_name.trim() : ""
    if (!data.is_subs_active) {
      return { plan: plan || null, lines: [ctx.line.badge({ label: "Subscription", text: "Unavailable", color: "#d97706" })] }
    }
    const lines = []
    const usage = data.subs_usage
    if (usage !== undefined && usage !== null && (typeof usage !== "object" || Array.isArray(usage))) invalid(ctx)
    for (const [key, label, duration] of [["window", "Session", 5 * 60 * 60 * 1000], ["weekly", "Weekly", 7 * 24 * 60 * 60 * 1000]]) {
      const window = usage && usage[key]
      if (window === undefined || window === null) continue
      if (typeof window !== "object" || Array.isArray(window) || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) || window.used_percent < 0) invalid(ctx)
      lines.push(ctx.line.progress({ label, used: window.used_percent, limit: 100, format: { kind: "percent" }, resetsAt: reset(ctx, window.resets_at), periodDurationMs: duration }))
    }
    if (lines.length < 2) {
      lines.push(ctx.line.text({ label: "Usage", value: lines.length ? "Some quota windows were not reported" : "Quota usage was not reported" }))
    }
    // user_email and the model api_key returned by this endpoint never enter plugin output or storage.
    return { plan: plan || null, lines }
  }

  globalThis.__openusage_plugin = { id: "muse", probe }
})()
