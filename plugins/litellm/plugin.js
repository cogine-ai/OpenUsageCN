(function () {
  function fail(ctx, reason, message) {
    ctx.host.log.error("LiteLLM " + reason)
    throw message || "LiteLLM usage response is invalid. Try again later."
  }

  function read(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null
  }

  function object(ctx, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(ctx, "response object is invalid")
    return value
  }

  function number(ctx, value) {
    if (value === null || value === undefined) return null
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(ctx, "spend or budget amount is invalid")
    return value
  }

  function settings(ctx) {
    const raw = read(ctx.host.config.get("baseUrl")) || read(ctx.host.env.get("LITELLM_BASE_URL"))
    let base = raw && ctx.host.http.normalizeConfiguredBaseUrl(raw)
    if (!base) fail(ctx, "proxy URL is invalid", "LiteLLM Proxy URL is invalid. Use HTTPS, or HTTP on a local or private network, without credentials or a query.")
    base = base.replace(/\/v1$/, "")
    const key = read(ctx.host.config.get("apiKey")) || read(ctx.host.env.get("LITELLM_API_KEY"))
    if (!key || /[\u0000-\u0020\u007f]/.test(key)) fail(ctx, "virtual API key is missing or invalid", "Add a LiteLLM virtual API key in Settings.")
    return { base, key, deadline: Date.now() + 25000 }
  }

  function request(ctx, config, path, query, optional) {
    const remaining = config.deadline - Date.now()
    if (remaining <= 0) fail(ctx, "usage request timed out", "LiteLLM requests timed out. Try again later.")
    let response
    try {
      response = ctx.util.request({ method: "GET", url: config.base + "/" + path + (query || ""),
        headers: { Authorization: "Bearer " + config.key, Accept: "application/json" }, timeoutMs: Math.min(15000, remaining) })
    } catch (_) {
      fail(ctx, "usage request failed", "LiteLLM request failed. Check your connection.")
    }
    if (optional && [401, 403, 404].includes(response.status)) {
      ctx.host.log.warn("LiteLLM " + path + " access is unavailable (HTTP " + response.status + ")")
      return null
    }
    if (response.status === 401) fail(ctx, "virtual API key was rejected", "LiteLLM API key is invalid or expired. Check your virtual API key.")
    if (response.status === 403) fail(ctx, "access was denied", "LiteLLM access was denied. Check this virtual key’s permissions.")
    if (response.status === 429) fail(ctx, "requests are rate limited", "LiteLLM is rate limiting requests. Try again later.")
    if (response.status < 200 || response.status >= 300) fail(ctx, "request returned HTTP " + response.status, "LiteLLM request failed. Try again later.")
    const data = ctx.util.tryParseJson(response.bodyText)
    if (!data || typeof data !== "object") fail(ctx, "response JSON is invalid")
    return data
  }

  function budget(ctx, info, label) {
    object(ctx, info)
    const spent = number(ctx, info.spend)
    const limit = number(ctx, info.max_budget)
    if (limit !== null && limit > 0 && spent === null) fail(ctx, "budget has no verified spend")
    if (spent === null) return null
    let resetsAt
    if (info.budget_reset_at != null) {
      const raw = read(info.budget_reset_at)
      const time = raw && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN
      if (Number.isFinite(time)) resetsAt = new Date(time).toISOString()
      else ctx.host.log.warn("LiteLLM budget reset date is unavailable")
    }
    return { spent, limit, resetsAt, label }
  }

  function membership(ctx, team, userId, teamId) {
    if (!team || team.team_memberships == null) return null
    if (!Array.isArray(team.team_memberships)) fail(ctx, "team membership list is invalid")
    const matches = team.team_memberships.map((entry) => object(ctx, entry))
      .filter((entry) => read(entry.user_id) === userId && (entry.team_id == null || read(entry.team_id) === teamId))
    if (matches.length > 1) fail(ctx, "team membership is ambiguous")
    if (!matches.length) return null
    const value = matches[0]
    return { table: value.litellm_budget_table == null ? null : object(ctx, value.litellm_budget_table), spend: number(ctx, value.spend) }
  }

  function teamInfo(ctx, config, teamId) {
    const response = request(ctx, config, "team/info", "?team_id=" + encodeURIComponent(teamId))
    const root = object(ctx, response)
    const info = object(ctx, root.team_info)
    if ((read(info.team_id) || read(root.team_id)) !== teamId) fail(ctx, "team identity did not match the virtual key")
    if (info.team_memberships == null && root.team_memberships != null) info.team_memberships = root.team_memberships
    return info
  }

  function pushBudget(ctx, lines, value) {
    if (!value) return
    if (value.limit !== null && value.limit > 0) {
      const options = { label: value.label + " Budget", used: value.spent, limit: value.limit, format: { kind: "dollars" } }
      if (value.resetsAt) options.resetsAt = value.resetsAt
      lines.push(ctx.line.progress(options))
    } else {
      lines.push(ctx.line.text({ label: value.label + " Spend", value: "$" + value.spent.toFixed(2), subtitle: "No Budget Reported" }))
    }
  }

  function spendOnly(ctx, config) {
    const end = ctx.nowIso.slice(0, 10)
    const start = end.slice(0, 7) + "-01"
    const query = "?start_date=" + start + "&end_date=" + end
    let label = "Key Spend"
    let rows = request(ctx, config, "key/spend/report", query, true)
    if (rows === null) {
      label = "User Spend"
      rows = request(ctx, config, "user/spend/report", query)
    }
    if (!Array.isArray(rows) || !rows.length) fail(ctx, "spend report is empty or invalid", "LiteLLM returned no spend records for this UTC month. Check your LiteLLM console.")
    let total = 0
    for (const row of rows) {
      const amount = number(ctx, object(ctx, row).total_cost)
      if (amount === null) fail(ctx, "spend report has no total cost")
      total += amount
      if (!Number.isFinite(total)) fail(ctx, "spend report total is not finite")
    }
    return { lines: [ctx.line.text({ label, value: "$" + total.toFixed(2), subtitle: start + "–" + end + " UTC" }),
      ctx.line.text({ label: "Scope", value: label + " Only · No Budget Or Reset Reported" })] }
  }

  function probe(ctx) {
    const config = settings(ctx)
    const keyResponse = request(ctx, config, "key/info", "", true)
    if (keyResponse === null) return spendOnly(ctx, config)
    const key = object(ctx, object(ctx, keyResponse).info)
    const userId = read(key.user_id)
    const teamId = read(key.team_id)
    if (!userId && !teamId) fail(ctx, "virtual key has no user or team identity", "LiteLLM did not return this virtual key’s user or team. Check your LiteLLM console.")
    const keySpend = number(ctx, key.spend)
    let personal = null
    let member = null
    let team = null
    let partial = false
    if (userId) {
      const root = object(ctx, request(ctx, config, "user/info", "?user_id=" + encodeURIComponent(userId)))
      const user = object(ctx, root.user_info)
      if ((read(user.user_id) || read(root.user_id)) !== userId) fail(ctx, "user identity did not match the virtual key")
      personal = budget(ctx, user, "Personal")
      if (root.teams != null && !Array.isArray(root.teams)) fail(ctx, "team list is invalid")
      if (teamId) {
        try {
          const matches = (root.teams || []).map((entry) => object(ctx, entry)).filter((entry) => read(entry.team_id) === teamId)
          if (matches.length > 1) fail(ctx, "selected team is ambiguous")
          let info = matches[0] || null
          if (info) team = budget(ctx, info, "Team")
          const initial = membership(ctx, info, userId, teamId)
          let fallback = null
          if (!team || !team.limit || (!personal || !personal.limit) && (!initial || !initial.table || initial.spend === null)) {
            info = teamInfo(ctx, config, teamId)
            const fetched = budget(ctx, info, "Team")
            if (!team || !team.limit && fetched && fetched.limit) team = fetched
            fallback = membership(ctx, info, userId, teamId)
          }
          if (!personal || !personal.limit) {
            let table = initial && initial.table && initial.table.max_budget != null ? initial.table : fallback && fallback.table
            if ((!table || table.max_budget == null) && info && info.team_member_budget_table != null) table = object(ctx, info.team_member_budget_table)
            const spent = initial && initial.spend !== null ? initial.spend : fallback && fallback.spend
            if (table && table.max_budget != null && spent != null) member = budget(ctx, { spend: spent, max_budget: table.max_budget, budget_reset_at: table.budget_reset_at }, "Team Member")
            else if (table && number(ctx, table.max_budget) > 0) partial = true
          }
        } catch (_) {
          ctx.host.log.warn("LiteLLM optional team or membership data could not be verified")
          partial = true
        }
      }
    } else {
      team = budget(ctx, teamInfo(ctx, config, teamId), "Team")
    }
    const lines = []
    pushBudget(ctx, lines, personal)
    pushBudget(ctx, lines, member)
    pushBudget(ctx, lines, team)
    if (!lines.length && keySpend !== null) lines.push(ctx.line.text({ label: "Key Spend", value: "$" + keySpend.toFixed(2) }))
    if (!lines.length) fail(ctx, "no verified spend or budget was returned", "LiteLLM did not return spend or budget data for this virtual key.")
    lines.push(ctx.line.text({ label: "Scope", value: teamId ? userId ? "Selected Virtual Key · User And Team" : "Selected Virtual Key · Team" : "Selected Virtual Key · User" }))
    if (partial) lines.push(ctx.line.text({ label: "Status", value: "Some Budget Data Unavailable", subtitle: "Team Or Membership Data Could Not Be Verified" }))
    return { lines }
  }

  globalThis.__openusage_plugin = { id: "litellm", probe }
})()
