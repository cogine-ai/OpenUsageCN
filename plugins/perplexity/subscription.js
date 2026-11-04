(function () {
  const NAMES = ["__Secure-authjs.session-token", "authjs.session-token", "__Secure-next-auth.session-token", "next-auth.session-token"]
  function cookie(raw) {
    if (typeof raw !== "string" || !raw.trim()) throw "Perplexity Web Subscription needs a Cookie header. Add it in Settings."
    const value = raw.trim().replace(/^cookie:\s*/i, "")
    if (/[\u0000-\u001f\u007f]/.test(value)) throw "Perplexity Cookie header is invalid. Copy it from the website."
    const pairs = new Map()
    for (const part of value.split(";")) {
      const index = part.indexOf("="), name = part.slice(0, index).trim(), text = part.slice(index + 1).trim()
      if (index < 1 || !name || !text || pairs.has(name)) throw "Perplexity Cookie header is invalid. Copy it from the website."
      pairs.set(name, text)
    }
    for (const expected of NAMES) {
      if (pairs.has(expected)) return expected + "=" + pairs.get(expected)
      const chunks = Array.from(pairs.keys()).filter((name) => name.startsWith(expected + "."))
      if (!chunks.length) continue
      if (chunks.some((name) => !/^(0|[1-9][0-9]*)$/.test(name.slice(expected.length + 1)))) throw "Perplexity session Cookie chunks are invalid. Copy the complete Cookie header."
      chunks.sort((a, b) => Number(a.slice(expected.length + 1)) - Number(b.slice(expected.length + 1)))
      if (!chunks.every((name, index) => name === expected + "." + index)) throw "Perplexity session Cookie chunks are incomplete. Copy the complete Cookie header."
      return expected + "=" + chunks.map((name) => pairs.get(name)).join("")
    }
    throw "Perplexity session Cookie is missing. Copy it from a signed-in website request."
  }
  function field(data, snake, camel) { return data[snake] === undefined ? data[camel] : data[snake] }
  function number(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw "Perplexity returned invalid subscription credit fields."
    return value
  }
  function parse(ctx, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw "Perplexity returned invalid subscription data."
    const balance = number(field(data, "balance_cents", "balanceCents")), renewal = number(field(data, "renewal_date_ts", "renewalDateTs"))
    const bought = number(field(data, "current_period_purchased_cents", "currentPeriodPurchasedCents"))
    let usage = number(field(data, "total_usage_cents", "totalUsageCents"))
    const grants = field(data, "credit_grants", "creditGrants")
    if (!Array.isArray(grants)) throw "Perplexity returned invalid subscription credit fields."
    const now = Date.parse(ctx.nowIso) / 1000, pools = { recurring: 0, purchased: 0, promotional: 0 }, expiries = []
    for (const grant of grants) {
      if (!grant || typeof grant.type !== "string") throw "Perplexity returned invalid subscription credit fields."
      const amount = number(field(grant, "amount_cents", "amountCents")), rawExpiry = field(grant, "expires_at_ts", "expiresAtTs")
      const expiry = rawExpiry === undefined || rawExpiry === null ? null : number(rawExpiry)
      if (grant.type === "promotional" && expiry !== null && expiry <= now) continue
      if (Object.prototype.hasOwnProperty.call(pools, grant.type)) pools[grant.type] += amount
      if (grant.type === "promotional" && expiry !== null) expiries.push(expiry)
    }
    pools.purchased = Math.max(pools.purchased, bought)
    for (const value of Object.values(pools)) number(value)
    const lines = []
    let personalLeft = 0
    for (const spec of [["recurring", "Subscription Credits", "subscriptionCredits"], ["purchased", "Purchased Credits", "purchasedCredits"], ["promotional", "Promotional Credits", "promotionalCredits"]]) {
      const total = pools[spec[0]], used = Math.min(usage, total)
      usage -= used
      personalLeft += total - used
      if (total > 0) {
        const opts = { label: spec[1], used, limit: total, format: { kind: "count", suffix: "credits" }, limitResourceKey: spec[2] }
        const reset = spec[0] === "recurring" ? renewal : spec[0] === "promotional" && expiries.length ? Math.min(...expiries) : null
        if (reset !== null && reset > 0 && Number.isFinite(new Date(reset * 1000).getTime())) opts.resetsAt = new Date(reset * 1000).toISOString()
        lines.push(ctx.line.progress(opts))
      }
    }
    const draws = field(data, "org_pool_draws_cents", "orgPoolDrawsCents"), cap = field(data, "org_user_cap_cents", "orgUserCapCents"), depleted = field(data, "is_org_pool_depleted", "isOrgPoolDepleted")
    if (depleted !== undefined && depleted !== null && typeof depleted !== "boolean") throw "Perplexity returned invalid organization credit fields."
    if (draws !== undefined && draws !== null || cap !== undefined && cap !== null) {
      const used = draws === undefined || draws === null ? 0 : number(draws)
      const available = depleted === true ? 0 : Math.max(0, balance - personalLeft), limit = number(used + available)
      if (limit > 0) lines.push(ctx.line.progress({ label: "Organization Credits", used, limit, format: { kind: "count", suffix: "credits" }, limitResourceKey: "organizationCredits" }))
      else lines.push(ctx.line.text({ label: "Organization Credits", value: "No Credits Available" }))
      if (cap !== undefined && cap !== null) lines.push(ctx.line.text({ label: "Member Cap Remaining", value: Math.max(0, number(cap) - used) + " credits" }))
    }
    if (!lines.length) lines.push(ctx.line.text({ label: "Subscription Credits", value: "No Credits Available" }))
    return { lines }
  }
  globalThis.__openusage_perplexity_subscription = function (ctx) {
    try {
      const header = cookie(ctx.host.config.get("webCookie"))
      const resp = ctx.util.request({ method: "GET", url: "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default", timeoutMs: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", Cookie: header, Accept: "application/json", Origin: "https://www.perplexity.ai", Referer: "https://www.perplexity.ai/account/usage" } })
      if (resp.status === 401) throw "Perplexity web session expired. Sign in again and update the Cookie header."
      if (resp.status === 403) throw "Perplexity denied access to subscription credits. Check website access and account permissions."
      if (resp.status < 200 || resp.status >= 300) throw "Perplexity subscription request failed (HTTP " + resp.status + "). Try again later."
      let data
      try { data = JSON.parse(resp.bodyText) } catch (_) { throw "Perplexity returned invalid subscription data." }
      return parse(ctx, data)
    } catch (error) {
      ctx.host.log.error("Perplexity subscription credits could not be loaded")
      throw typeof error === "string" ? error : "Could not load Perplexity subscription credits. Check Settings and your connection."
    }
  }
})()
