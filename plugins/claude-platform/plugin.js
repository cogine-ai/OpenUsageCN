(function () {
  const ORIGIN = "https://platform.claude.com"

  function fail(ctx, reason, message) {
    ctx.host.log.error("Claude Platform " + reason)
    throw message || "Claude Platform billing response is invalid. Try again later."
  }

  function read(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null
  }

  function object(ctx, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(ctx, "response object is invalid")
    return value
  }

  function minor(ctx, value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(ctx, "credit amount is invalid")
    return value
  }

  function cookie(ctx) {
    const raw = read(ctx.host.config.get("cookieHeader")) || read(ctx.host.env.get("CLAUDE_PLATFORM_COOKIE"))
    const value = raw && raw.replace(/^Cookie:\s*/i, "")
    const pairs = value && value.split(";").map((part) => part.trim()).filter(Boolean)
    if (!value || /[\u0000-\u001f\u007f]/.test(value) || !pairs.length ||
      !pairs.every((part) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*$/.test(part)) ||
      !pairs.some((part) => /^sessionKey=\S+$/.test(part))) {
      fail(ctx, "session cookie is missing or invalid", "Claude Platform needs a Cookie header containing sessionKey. Add it in Settings.")
    }
    return pairs.join("; ")
  }

  function request(ctx, session, path, deadline, organizations) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) fail(ctx, "billing request timed out", "Claude Platform requests timed out. Try again later.")
    let response
    try {
      response = ctx.util.request({ method: "GET", url: ORIGIN + path,
        headers: { Cookie: session, Accept: "application/json" }, timeoutMs: Math.min(15000, remaining) })
    } catch (_) {
      fail(ctx, "billing request failed", "Claude Platform request failed. Check your connection.")
    }
    if (response.status === 401 || organizations && response.status === 403) {
      fail(ctx, "session was rejected", "Claude Platform session expired. Sign in to Claude Console and update its Cookie header.")
    }
    if (response.status === 403) fail(ctx, "billing access was denied", "Claude Platform billing access was denied. Ask the organization owner for access.")
    if (response.status === 429) fail(ctx, "requests are rate limited", "Claude Platform is rate limiting requests. Try again later.")
    if (response.status !== 200) fail(ctx, "request returned HTTP " + response.status, "Claude Platform request failed. Try again later.")
    const data = ctx.util.tryParseJson(response.bodyText)
    if (!data || typeof data !== "object") fail(ctx, "response JSON is invalid")
    return data
  }

  function organization(ctx, list, configured) {
    if (!Array.isArray(list)) fail(ctx, "organization list is invalid")
    const candidates = []
    const seen = new Set()
    for (const raw of list) {
      const org = object(ctx, raw)
      if (!Array.isArray(org.capabilities) || !org.capabilities.includes("api")) continue
      const id = read(org.uuid)
      if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id) || seen.has(id)) fail(ctx, "API organization ID is invalid or duplicated")
      seen.add(id)
      candidates.push(id)
    }
    if (configured) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(configured)) fail(ctx, "configured organization ID is invalid", "Claude Platform Organization ID is invalid. Check Settings.")
      if (!candidates.includes(configured)) fail(ctx, "configured organization is not in this session", "The configured Claude Platform API organization is unavailable. Check Organization ID in Settings.")
      return configured
    }
    if (!candidates.length) fail(ctx, "session has no API organization", "This Claude account has no Claude Platform API organization.")
    if (candidates.length > 1) fail(ctx, "API organization choice is required", "Multiple Claude Platform API organizations are available. Add an Organization ID in Settings.")
    return candidates[0]
  }

  function grants(ctx, credits, now) {
    const values = []
    for (const [field, purchased] of [["promo_tranches", false], ["tranches", true]]) {
      const list = credits[field]
      if (list === undefined || list === null) continue
      if (!Array.isArray(list)) fail(ctx, "credit grant list is invalid")
      for (const raw of list) {
        const grant = object(ctx, raw)
        const granted = minor(ctx, grant.granted_amount_minor_units)
        const remaining = Math.max(0, minor(ctx, grant.remaining_amount_minor_units))
        const expiry = read(grant.expires_at)
        let expiresAt = null
        if (expiry) {
          const parsed = /^\d{4}-\d{2}-\d{2}T/.test(expiry) ? Date.parse(expiry) : NaN
          if (Number.isFinite(parsed)) expiresAt = parsed
          else ctx.host.log.warn("Claude Platform credit grant expiry is unavailable")
        }
        if (granted <= 0 || expiresAt !== null && expiresAt <= now) continue
        values.push({ granted, remaining, expiresAt, purchased, subscription: grant.program_id === "subscription_api_credit" })
      }
    }
    values.sort((a, b) => (a.expiresAt === null ? Infinity : a.expiresAt) - (b.expiresAt === null ? Infinity : b.expiresAt))
    return values
  }

  function probe(ctx) {
    const session = cookie(ctx)
    const configured = read(ctx.host.config.get("organizationId")) || read(ctx.host.env.get("CLAUDE_PLATFORM_ORGANIZATION_ID"))
    const deadline = Date.now() + 25000
    const id = organization(ctx, request(ctx, session, "/api/organizations", deadline, true), configured)
    const prefix = "/api/organizations/" + encodeURIComponent(id)
    const credits = object(ctx, request(ctx, session, prefix + "/prepaid/credits", deadline))
    const currency = read(credits.currency) || "USD"
    if (!/^[A-Z]{3}$/.test(currency)) fail(ctx, "currency is invalid")
    let exponent = 2
    if (credits.balance !== undefined && credits.balance !== null) {
      const balance = object(ctx, credits.balance)
      const nested = balance.credits == null ? {} : object(ctx, balance.credits)
      if (nested.exponent !== undefined && nested.exponent !== null) exponent = nested.exponent
    }
    if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) fail(ctx, "currency exponent is invalid")
    const money = (value) => {
      const n = value / Math.pow(10, exponent)
      const prefix = currency === "USD" ? "$" : currency === "CNY" ? "CN¥" : currency + " "
      return (n < 0 ? "-" : "") + prefix + Math.abs(n).toFixed(exponent)
    }
    const lines = [ctx.line.text({ label: "Prepaid Balance", value: money(minor(ctx, credits.amount)) })]
    const now = Date.parse(ctx.nowIso)
    const all = grants(ctx, credits, now)
    const subscription = all.find((grant) => grant.subscription && grant.remaining > 0)
    const purchased = all.find((grant) => grant !== subscription && grant.purchased && grant.remaining > 0) || all.find((grant) => grant !== subscription && grant.purchased)
    const expiry = (grant) => grant.expiresAt === null ? "Expiry Unavailable" : "Expires " + new Date(grant.expiresAt).toISOString().slice(0, 10) + " (UTC)"
    for (const [grant, label] of [[subscription, "API Credit"], [purchased, "Purchased Credit"]]) {
      if (!grant) continue
      lines.push(ctx.line.progress({ label, used: Math.max(0, (grant.granted - grant.remaining) / grant.granted * 100), limit: 100,
        format: { kind: "percent" } }))
      lines.push(ctx.line.text({ label: label + " Remaining", value: money(grant.remaining) + " / " + money(grant.granted), subtitle: expiry(grant) }))
    }
    const other = all.filter((grant) => grant !== subscription && grant !== purchased)
    if (other.length) lines.push(ctx.line.text({ label: "Other Credit Grants", value: other.length + " unexpired grants · " + expiry(other[0]) }))
    lines.push(ctx.line.text({ label: "Scope", value: "Selected API Organization" }))
    try {
      const spend = object(ctx, request(ctx, session, prefix + "/current_spend", deadline))
      const amount = minor(ctx, spend.amount)
      if (amount < 0) fail(ctx, "monthly spend is negative")
      lines.push(ctx.line.text({ label: "This Month Spend", value: money(amount), subtitle: "UTC" }))
    } catch (_) {
      ctx.host.log.warn("Claude Platform monthly spend is unavailable; credit balance retained")
      lines.push(ctx.line.text({ label: "This Month Spend", value: "Unavailable", subtitle: "UTC · Balance Remains Available" }))
    }
    return { lines }
  }

  globalThis.__openusage_plugin = { id: "claude-platform", probe }
})()
