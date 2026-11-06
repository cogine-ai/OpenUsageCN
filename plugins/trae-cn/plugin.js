(function () {
  const ORIGIN = "https://api.trae.cn"

  function fail(ctx, reason, message) {
    ctx.host.log.error("Trae CN usage failed: " + reason)
    throw message
  }

  function invalid(ctx) {
    fail(ctx, "invalid response", "Trae CN usage response changed. Try again later.")
  }

  function post(ctx, cookie, path, body, token) {
    const headers = {
      Accept: "application/json", "Content-Type": "application/json",
      Cookie: cookie, Origin: "https://www.trae.cn", Referer: "https://www.trae.cn/",
    }
    if (token) headers.Authorization = "Cloud-IDE-JWT " + token
    let response
    try {
      response = ctx.util.request({ method: "POST", url: ORIGIN + path, headers, bodyText: JSON.stringify(body), timeoutMs: 15000 })
    } catch (_) {
      fail(ctx, "network request", "Trae CN request failed. Check your connection.")
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      fail(ctx, "authentication rejected", "Trae CN session expired. Copy a fresh Cookie from the signed-in dashboard.")
    }
    if (response.status === 403) fail(ctx, "access denied", "Trae CN denied access to usage data.")
    if (response.status === 429) fail(ctx, "rate limited", "Trae CN requests are rate limited. Try again later.")
    if (response.status !== 200) fail(ctx, "HTTP " + response.status, "Trae CN usage request failed. Try again later.")
    const data = ctx.util.tryParseJson(response.bodyText)
    if (!data || typeof data !== "object" || Array.isArray(data)) invalid(ctx)
    if (data.code === 1001) fail(ctx, "session rejected", "Trae CN session expired. Copy a fresh Cookie from the signed-in dashboard.")
    return data
  }

  function amount(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
  }

  function probe(ctx) {
    const configured = ctx.host.config.get("cookie")
    const raw = typeof configured === "string" && configured.trim() ? configured : ctx.host.env.get("TRAE_CN_COOKIE")
    if (typeof raw !== "string" || !raw.trim()) {
      fail(ctx, "missing connection", "Add a Cookie header from the signed-in Trae CN dashboard.")
    }
    if (/[\r\n\u0000]/.test(raw)) fail(ctx, "invalid Cookie", "Cookie must be a single request-header value.")
    const cookie = raw.trim()
    const exchanged = post(ctx, cookie, "/cloudide/api/v3/common/GetUserToken", {})
    const token = exchanged.Result && exchanged.Result.Token
    if (typeof token !== "string" || !token.trim() || /[\x00-\x20\x7f]/.test(token)) invalid(ctx)
    // This token belongs only to this refresh, and is sent only to the fixed Trae CN origin.
    const data = post(ctx, cookie, "/trae/api/v2/pay/user_current_entitlement_list", { require_usage: true, full_data: true }, token)
    const summary = data.usage_summary
    if (data.is_credits_billing !== true || !summary || !amount(summary.total_amount) || !amount(summary.consumed_amount)) invalid(ctx)
    const total = summary.total_amount
    const used = summary.consumed_amount
    const remaining = Math.max(0, total - used)
    const fractional = [used, total, remaining].some((value) => !Number.isInteger(value))
    const format = (value) => value > 0 && value < 0.01 ? "<0.01" : fractional ? value.toFixed(2) : String(value)
    const lines = []
    if (total > 0) lines.push(ctx.line.progress({ label: "Usage", used, limit: total, format: { kind: "count", suffix: "credits" } }))
    for (const [label, value] of [["Used", used], ["Total", total], ["Remaining", remaining]]) {
      lines.push(ctx.line.text({ label, value: format(value) + " credits" }))
    }
    const packs = Array.isArray(data.user_entitlement_pack_list) ? data.user_entitlement_pack_list : []
    const membership = packs.find((item) => item && item.group_type === 0 && (item.status === undefined || item.status === 1))
    const plan = membership && typeof membership.display_desc === "string" ? membership.display_desc.trim() : ""
    // Individual pack expiries do not establish one aggregate allowance reset.
    return { plan: plan || null, lines }
  }

  globalThis.__openusage_plugin = { id: "trae-cn", probe }
})()
