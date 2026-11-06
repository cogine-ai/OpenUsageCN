(function () {
  const URL = "https://www.workbuddy.cn/billing/meter/get-user-resource-summary"

  function input(ctx, key, environment) {
    const configured = ctx.host.config.get(key)
    if (typeof configured === "string" && configured.trim()) return configured
    const value = ctx.host.env.get(environment)
    return typeof value === "string" && value.trim() ? value : null
  }

  function fail(ctx, reason, message) {
    ctx.host.log.error("WorkBuddy usage failed: " + reason)
    throw message
  }

  function invalid(ctx, field) {
    fail(ctx, "invalid " + field, "WorkBuddy usage response changed. Try again later.")
  }

  function amount(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null
    const number = Number(value.trim())
    return Number.isFinite(number) ? number : null
  }

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function pool(raw, totalField, remainingField) {
    const total = amount(raw[totalField])
    const remaining = amount(raw[remainingField])
    if (total === null || remaining === null) return null
    return { total, remaining }
  }

  function format(value) {
    if (value > 0 && value < 0.01) return "<0.01"
    return String(Number(value.toFixed(2)))
  }

  function meter(ctx, label, total, remaining) {
    if (total === 0) {
      return ctx.line.text({ label, value: format(remaining) + " / " + format(total) + " credits remaining" })
    }
    return ctx.line.progress({
      label,
      used: Math.max(0, total - remaining),
      limit: total,
      format: { kind: "count", suffix: "credits" },
    })
  }

  function probe(ctx) {
    const cookie = input(ctx, "cookie", "WORKBUDDY_COOKIE")
    const userAgent = input(ctx, "userAgent", "WORKBUDDY_USER_AGENT")
    if (!cookie || !userAgent) {
      fail(ctx, "missing connection", "Add the Cookie and matching User-Agent from a WorkBuddy usage-page request.")
    }
    if (/[\r\n\u0000]/.test(cookie) || /[^\x20-\x7e]/.test(userAgent)) {
      fail(ctx, "invalid request headers", "Cookie and User-Agent must each be a single request-header value.")
    }
    let response
    try {
      response = ctx.util.request({
        method: "POST", url: URL,
        headers: {
          Accept: "application/json", "Content-Type": "application/json",
          Cookie: cookie.trim(), "User-Agent": userAgent.trim(),
          Origin: "https://www.workbuddy.cn", Referer: "https://www.workbuddy.cn/profile/plans-usage",
        },
        bodyText: "{}", timeoutMs: 15000,
      })
    } catch (_) {
      fail(ctx, "network request", "WorkBuddy request failed. Check your connection.")
    }
    if (response.status === 401) {
      fail(ctx, "authentication rejected", "WorkBuddy session expired or its User-Agent does not match. Copy both from the same request.")
    }
    if (response.status === 403) fail(ctx, "access denied", "WorkBuddy denied access to usage data.")
    if (response.status === 429) fail(ctx, "rate limited", "WorkBuddy requests are rate limited. Try again later.")
    if (response.status !== 200) fail(ctx, "HTTP " + response.status, "WorkBuddy usage request failed. Try again later.")
    const data = ctx.util.tryParseJson(response.bodyText)
    if (!object(data) || typeof data.code !== "number" || !Number.isFinite(data.code)) invalid(ctx, "summary")
    if (data.code !== 0) fail(ctx, "billing request rejected", "WorkBuddy rejected the usage request. Check your session or try again later.")
    if (!object(data.data) || !Array.isArray(data.data.Packages)) invalid(ctx, "summary")
    const summary = data.data
    let total = 0
    let remaining = 0
    let reserved = 0
    let packages = 0
    for (const item of summary.Packages) {
      if (!object(item)) invalid(ctx, "package")
      if (item.CapacityUnit !== "credits") continue
      const value = pool(item, "CycleTotalCapacity", "CycleRemainCapacity")
      if (!value) invalid(ctx, "credit amounts")
      total += value.total
      remaining += value.remaining
      if (item.CycleFrozenCapacity !== undefined) {
        const frozen = amount(item.CycleFrozenCapacity)
        if (frozen === null) invalid(ctx, "reserved amount")
        reserved += frozen
      }
      packages += 1
    }
    if (![total, remaining, reserved].every(Number.isFinite)) invalid(ctx, "credit totals")
    const lines = packages
      ? [meter(ctx, "Credits", total, remaining)]
      : [ctx.line.text({ label: "Credits", value: "Not reported" })]
    if (total > 0 && remaining > total) lines.push(ctx.line.text({ label: "Credits Remaining", value: format(remaining) + " credits" }))
    if (reserved > 0) lines.push(ctx.line.text({ label: "Reserved", value: format(reserved) + " credits" }))

    // Rewards are part of the overall Credits amount, never another allowance to add to it.
    if (summary.CreditGroups !== undefined && summary.CreditGroups !== null) {
      let invalidRewards = !Array.isArray(summary.CreditGroups)
      let rewardTotal = 0
      let rewardRemaining = 0
      let rewards = 0
      if (!invalidRewards) {
        for (const item of summary.CreditGroups) {
          if (!object(item)) { invalidRewards = true; break }
          if (item.Kind !== "benefit" || item.CapacityUnit !== "credits") continue
          const value = pool(item, "CycleTotalCapacity", "CycleRemainCapacity")
          if (!value) { invalidRewards = true; break }
          rewardTotal += value.total
          rewardRemaining += value.remaining
          rewards += 1
        }
      }
      if (!Number.isFinite(rewardTotal) || !Number.isFinite(rewardRemaining)) invalidRewards = true
      if (invalidRewards) {
        ctx.host.log.warn("WorkBuddy reward breakdown is unavailable")
        lines.push(ctx.line.text({ label: "Rewards", value: "Unavailable; overall Credits remain available" }))
      } else if (rewards) {
        lines.push(meter(ctx, "Rewards", rewardTotal, rewardRemaining))
        if (rewardTotal > 0 && rewardRemaining > rewardTotal) lines.push(ctx.line.text({ label: "Rewards Remaining", value: format(rewardRemaining) + " credits" }))
      }
    }
    const plan = typeof summary.SubscriptionPackageName === "string" ? summary.SubscriptionPackageName.trim() : ""
    return { plan: plan || null, lines }
  }

  globalThis.__openusage_plugin = { id: "workbuddy", probe }
})()
