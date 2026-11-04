(function () {
  const BASES = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"]
  const SPECS = [
    ["gemini-5h", "Gemini", "geminiSession", 18000000],
    ["gemini-weekly", "Gemini Weekly", "geminiWeekly", 604800000],
    ["3p-5h", "Claude", "claude", 18000000],
    ["3p-weekly", "Claude Weekly", "claudeWeekly", 604800000],
  ]

  function usable(bucket) {
    return bucket && typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction) &&
      (bucket.disabled == null || typeof bucket.disabled === "boolean") && bucket.disabled !== true
  }

  function groups(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null
    const value = body.response && body.response.groups != null ? body.response.groups : body.groups
    if (!Array.isArray(value) || !value.every((group) => group && typeof group === "object" &&
      (group.buckets === undefined || Array.isArray(group.buckets)))) return null
    return value
  }

  function parse(bodies, ctx) {
    const pooled = Object.create(null)
    let argon = null
    for (const body of bodies) {
      const list = groups(body)
      if (!list) throw "Antigravity quota response invalid. Try again later."
      for (const group of list) {
        if (group.displayName === "Gemini 4 Argon") continue
        for (const bucket of group.buckets || []) {
          const spec = SPECS.find((item) => bucket && item[0] === bucket.bucketId)
          if (!spec || pooled[spec[0]] || !usable(bucket)) continue
          // Known bucket identity establishes the window; contradictory metadata is rejected.
          if (bucket.window !== undefined && bucket.window !== (spec[3] === 604800000 ? "weekly" : "5h")) {
            ctx.host.log.warn("Antigravity quota bucket has an unsupported window")
            continue
          }
          pooled[spec[0]] = bucket
        }
      }
      if (!argon) {
        const candidates = list.filter((group) => group.displayName === "Gemini 4 Argon")
          .flatMap((group) => group.buckets || []).filter((bucket) => bucket && bucket.window === "weekly")
        if (candidates.length === 1 && typeof candidates[0].bucketId === "string" && candidates[0].bucketId &&
            !SPECS.some((spec) => spec[0] === candidates[0].bucketId) && usable(candidates[0])) argon = candidates[0]
      }
    }
    function line(spec, bucket) {
      const reset = typeof bucket.resetTime === "string" && Number.isFinite(Date.parse(bucket.resetTime)) ? bucket.resetTime : undefined
      return ctx.line.progress({ label: spec[1], limitResourceKey: spec[2], used: Math.round((1 - Math.max(0, Math.min(1, bucket.remainingFraction))) * 100),
        limit: 100, format: { kind: "percent" }, resetsAt: reset, periodDurationMs: spec[3] })
    }
    const lines = SPECS.filter((spec) => pooled[spec[0]]).map((spec) => line(spec, pooled[spec[0]]))
    if (argon) lines.splice(Math.min(2, lines.length), 0, line(["argon", "Argon Weekly", "argonWeekly", 604800000], argon))
    return { lines, complete: SPECS.every((spec) => pooled[spec[0]]) }
  }

  function request(ctx, base, path, token, body) {
    try {
      const resp = ctx.host.http.request({ method: "POST", url: base + path,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + token,
          "User-Agent": "antigravity/2.24.0 (aidev_client; os_type=darwin; arch=arm64)" },
        bodyText: JSON.stringify(body), timeoutMs: 10000 })
      if (!resp || !Number.isFinite(resp.status)) return { status: 0 }
      return { status: resp.status, data: ctx.util.tryParseJson(resp.bodyText) }
    } catch (_) {
      ctx.host.log.warn("Antigravity quota request failed")
      return { status: 0 }
    }
  }

  function read(ctx, token) {
    let project = null, plan = null
    // Project and plan must come from the same token as the quota, never another LS account.
    for (const base of BASES) {
      const load = request(ctx, base, "/v1internal:loadCodeAssist", token,
        { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } })
      if (load.status === 401) return { _authFailed: true }
      if (load.status >= 200 && load.status < 300 && load.data && typeof load.data === "object") {
        project = typeof load.data.cloudaicompanionProject === "string" ? load.data.cloudaicompanionProject.trim() : null
        const tier = load.data.paidTier || load.data.currentTier
        plan = tier && typeof tier.name === "string" ? tier.name.trim() || null : null
        break
      }
    }
    const bodies = [], responses = []
    for (const base of BASES) {
      const response = request(ctx, base, "/v1internal:retrieveUserQuotaSummary", token, project ? { project } : {})
      responses.push(response)
      if (response.status >= 200 && response.status < 300) {
        if (!groups(response.data)) {
          ctx.host.log.error("Antigravity quota response has no valid groups")
          throw "Antigravity quota response invalid. Try again later."
        }
        bodies.push(response.data)
        if (parse(bodies, ctx).complete) break
      }
    }
    if (bodies.length) {
      const result = parse(bodies, ctx)
      if (!result.lines.length) {
        ctx.host.log.error("Antigravity quota summary has no usable quota buckets")
        throw "Antigravity quota data unavailable. Try again later."
      }
      return { plan, lines: result.lines }
    }
    if (responses.every((response) => response.status === 404 || response.status === 405)) return { unsupported: true }
    if (responses.some((response) => response.status === 401)) return { _authFailed: true }
    if (responses.some((response) => response.status === 403 && response.data && response.data.error &&
        Array.isArray(response.data.error.details) && response.data.error.details.some((detail) => detail && detail.reason === "SUBSCRIPTION_REQUIRED"))) {
      ctx.host.log.error("Antigravity quota subscription required")
      throw "Google reports no Antigravity quota subscription for this project."
    }
    if (responses.some((response) => response.status === 403)) {
      ctx.host.log.error("Antigravity quota access denied")
      throw "Antigravity quota access denied. Check access in Antigravity and try again."
    }
    if (responses.some((response) => response.status === 429)) {
      ctx.host.log.error("Antigravity quota rate limited")
      throw "Antigravity is rate limiting requests. Try again later."
    }
    ctx.host.log.error("Antigravity quota summary unavailable")
    throw "Antigravity quota request failed. Try again later."
  }
  globalThis.__antigravitySummary = { read, parse }
})()
