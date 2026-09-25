(function () {
  const ROOT = "https://management-api.x.ai/v1/billing/teams/"

  function setting(ctx, key, env) {
    const configured = ctx.host.config.get(key)
    if (typeof configured === "string" && configured.trim()) return configured.trim()
    const fallback = ctx.host.env.get(env)
    return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null
  }

  function request(ctx, options) {
    try {
      return ctx.host.http.request(options)
    } catch (error) {
      ctx.host.log.error("xAI Management API network request failed")
      throw "xAI usage request failed. Check your connection."
    }
  }

  function json(ctx, response) {
    let data
    try {
      data = JSON.parse(response.bodyText)
    } catch (error) {
      ctx.host.log.error("xAI Management API returned invalid JSON")
      throw "xAI usage response invalid. Try again later."
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      ctx.host.log.error("xAI Management API returned an invalid response object")
      throw "xAI usage response invalid. Try again later."
    }
    return data
  }

  function checkStatus(ctx, response) {
    if (response.status === 401 || response.status === 403) {
      ctx.host.log.error("xAI Management API denied access (HTTP " + response.status + ")")
      throw "xAI Management API key invalid or lacks billing access. Inference keys cannot read billing."
    }
    if (response.status === 404) {
      ctx.host.log.error("xAI Management API team not found (HTTP 404)")
      throw "xAI team not found. Check the Team ID and Management API key."
    }
    if (response.status < 200 || response.status >= 300) {
      ctx.host.log.error("xAI Management API failed (HTTP " + response.status + ")")
      throw "xAI usage request failed (HTTP " + response.status + "). Try again later."
    }
  }

  function utcStamp(date) {
    return date.toISOString().slice(0, 19).replace("T", " ")
  }

  function parseHistory(data) {
    if (!Array.isArray(data.timeSeries)) throw new Error("invalid timeSeries")
    const totals = {}
    for (const series of data.timeSeries) {
      if (!series || !Array.isArray(series.dataPoints)) throw new Error("invalid dataPoints")
      for (const point of series.dataPoints) {
        if (!point || typeof point.timestamp !== "string") throw new Error("invalid timestamp")
        const date = new Date(point.timestamp)
        const value = point && Array.isArray(point.values) ? point.values[0] : null
        if (!Number.isFinite(date.getTime()) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error("invalid daily spend")
        }
        const day = date.toISOString().slice(0, 10)
        totals[day] = (totals[day] || 0) + value
      }
    }
    return Object.keys(totals).sort().map((day) => ({ label: day, value: totals[day] }))
  }

  function probe(ctx) {
    const key = setting(ctx, "managementKey", "XAI_MANAGEMENT_API_KEY")
    const team = setting(ctx, "teamId", "XAI_TEAM_ID")
    if (!key) {
      ctx.host.log.error("xAI Management API key is missing")
      throw "No xAI Management API key found. Add one in Settings or set XAI_MANAGEMENT_API_KEY."
    }
    if (!team || !/^[A-Za-z0-9_-]+$/.test(team)) {
      ctx.host.log.error("xAI Team ID is missing or invalid")
      throw "Missing or invalid xAI Team ID."
    }

    const root = ROOT + encodeURIComponent(team)
    const headers = { Authorization: "Bearer " + key, Accept: "application/json" }
    const balanceResponse = request(ctx, { method: "GET", url: root + "/prepaid/balance", headers, timeoutMs: 15000 })
    checkStatus(ctx, balanceResponse)
    const balanceData = json(ctx, balanceResponse)
    const cents = balanceData.total && balanceData.total.val
    if (typeof cents !== "string" || !/^-?\d+(\.\d+)?$/.test(cents.trim()) || !Number.isFinite(Number(cents))) {
      ctx.host.log.error("xAI Management API balance total.val is invalid")
      throw "xAI balance response invalid. Try again later."
    }
    // xAI reports the prepaid ledger with the opposite sign, in USD cents.
    const balance = -Number(cents) / 100
    const lines = [ctx.line.text({ label: "Prepaid Balance", value: "$" + balance.toFixed(2) })]

    const now = new Date(ctx.nowIso)
    const end = Number.isFinite(now.getTime()) ? now : new Date()
    const start = new Date(end.getTime())
    start.setUTCDate(start.getUTCDate() - 29)
    start.setUTCHours(0, 0, 0, 0)
    const body = JSON.stringify({ analyticsRequest: {
      timeRange: { startTime: utcStamp(start), endTime: utcStamp(end), timezone: "Etc/GMT" },
      timeUnit: "TIME_UNIT_DAY",
      values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
      groupBy: [], filters: [],
    } })
    try {
      const usageResponse = request(ctx, {
        method: "POST", url: root + "/usage",
        headers: Object.assign({}, headers, { "Content-Type": "application/json" }),
        bodyText: body, timeoutMs: 15000,
      })
      checkStatus(ctx, usageResponse)
      const usageData = json(ctx, usageResponse)
      const points = parseHistory(usageData)
      const spend = points.reduce((sum, point) => sum + point.value, 0)
      lines.push(ctx.line.text({ label: "30D Spend", value: "$" + spend.toFixed(2), subtitle: usageData.limitReached === true ? "Partial history" : undefined }))
      lines.push(ctx.line.barChart({ label: "Daily Spend", points, note: usageData.limitReached === true ? "Partial history" : undefined }))
    } catch (error) {
      if (String(error).includes("Management API key invalid") || String(error).includes("team not found")) throw error
      ctx.host.log.warn("xAI usage history unavailable: " + String(error))
    }
    return { plan: "Management API", lines }
  }

  globalThis.__openusage_plugin = { id: "xai", probe }
})()
