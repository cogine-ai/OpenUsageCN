(function () {
  const ORIGINS = { china: "https://api.siliconflow.cn", international: "https://api.siliconflow.com" }

  function fail(ctx, reason, message) {
    ctx.host.log.error("SiliconFlow " + reason)
    throw message || "SiliconFlow balance response is invalid. Try again later."
  }

  function read(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null
  }

  function amount(ctx, value) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) fail(ctx, "balance amount is invalid")
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) fail(ctx, "balance amount is not finite")
    return parsed
  }

  function probe(ctx) {
    const configuredRegion = read(ctx.host.config.get("region"))
    const region = !configuredRegion || configuredRegion === "auto"
      ? read(ctx.host.env.get("SILICONFLOW_REGION")) || "china"
      : configuredRegion
    if (!Object.prototype.hasOwnProperty.call(ORIGINS, region)) {
      fail(ctx, "region is invalid", "Choose China or International in SiliconFlow settings.")
    }
    const key = read(ctx.host.config.get("apiKey")) || read(ctx.host.env.get("SILICONFLOW_API_KEY"))
    if (!key || /[\u0000-\u0020\u007f]/.test(key)) {
      fail(ctx, "API key is missing or invalid", "Add a valid SiliconFlow API key in Settings.")
    }
    let response
    try {
      response = ctx.util.request({ method: "GET", url: ORIGINS[region] + "/v1/user/info",
        headers: { Authorization: "Bearer " + key, Accept: "application/json" }, timeoutMs: 15000 })
    } catch (_) {
      fail(ctx, "balance request failed", "SiliconFlow request failed. Check your connection.")
    }
    const data = ctx.util.tryParseJson(response.bodyText)
    if (response.status === 410 || data && data.code === 20092) {
      fail(ctx, "balance query was refused", "SiliconFlow refused the balance query. Check the SiliconFlow console.")
    }
    if (response.status === 401 || response.status === 403 || data && data.code === 30014) {
      fail(ctx, "API key was rejected", "SiliconFlow API key is invalid or lacks access. Check your API key.")
    }
    if (response.status === 429) fail(ctx, "requests are rate limited", "SiliconFlow is rate limiting requests. Try again later.")
    if (response.status !== 200) fail(ctx, "request returned HTTP " + response.status, "SiliconFlow request failed. Try again later.")
    if (!data || Array.isArray(data) || data.code !== 20000 || data.status !== true ||
      !data.data || typeof data.data !== "object" || Array.isArray(data.data)) fail(ctx, "response shape is invalid")

    const currency = region === "china" ? "CNY" : "USD"
    const money = (value) => {
      const n = amount(ctx, value)
      return (n < 0 ? "-" : "") + (currency === "CNY" ? "CN¥" : "$") + Math.abs(n).toFixed(2)
    }
    const lines = [ctx.line.text({ label: "Balance", value: money(data.data.totalBalance) })]
    for (const [field, label] of [["chargeBalance", "Purchased"], ["balance", "Bonus"]]) {
      if (data.data[field] !== undefined && data.data[field] !== null) {
        lines.push(ctx.line.text({ label, value: money(data.data[field]) }))
      }
    }
    lines.push(ctx.line.text({ label: "Region", value: region === "china" ? "China · CNY" : "International · USD" }))
    if (data.data.status !== undefined && data.data.status !== null) {
      if (typeof data.data.status !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(data.data.status)) fail(ctx, "account status is invalid")
      if (data.data.status !== "normal") lines.push(ctx.line.text({ label: "Status", value: data.data.status }))
    }
    return { lines }
  }

  globalThis.__openusage_plugin = { id: "siliconflow", probe }
})()
