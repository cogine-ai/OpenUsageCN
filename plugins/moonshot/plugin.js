(function () {
  const ORIGINS = {
    international: "https://api.moonshot.ai",
    china: "https://api.moonshot.cn",
  }

  function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null
  }

  function config(ctx, key) {
    return readString(ctx.host.config.get(key))
  }

  function env(ctx, key) {
    return readString(ctx.host.env.get(key))
  }

  function region(ctx) {
    const configured = config(ctx, "region")
    const value = !configured || configured === "auto"
      ? env(ctx, "MOONSHOT_REGION") || "international"
      : configured
    if (!Object.prototype.hasOwnProperty.call(ORIGINS, value)) {
      ctx.host.log.error("Moonshot region is invalid")
      throw "Choose a valid Moonshot API region in Settings or MOONSHOT_REGION."
    }
    return value
  }

  function apiKey(ctx, selectedRegion) {
    const saved = config(ctx, selectedRegion === "china" ? "apiKeyCn" : "apiKeyIntl")
    if (saved) return saved

    const environmentKey = env(ctx, "MOONSHOT_API_KEY")
    const environmentRegion = env(ctx, "MOONSHOT_REGION") || "international"
    if (environmentKey && environmentRegion === selectedRegion) return environmentKey
    return null
  }

  function amount(ctx, data, field) {
    const value = data[field]
    if (typeof value !== "number" || !Number.isFinite(value)) {
      ctx.host.log.error("Moonshot balance response has invalid " + field)
      throw "Moonshot balance response is invalid. Try again later."
    }
    return value
  }

  function money(value, selectedRegion) {
    const symbol = selectedRegion === "china" ? "CN¥" : "$"
    return (value < 0 ? "-" : "") + symbol + Math.abs(value).toFixed(2)
  }

  function probe(ctx) {
    const selectedRegion = region(ctx)
    const key = apiKey(ctx, selectedRegion)
    if (!key) {
      ctx.host.log.error("Moonshot API key for selected region is missing")
      throw "No Moonshot API key for this region. Add it in Settings or set MOONSHOT_API_KEY and MOONSHOT_REGION."
    }

    let response
    try {
      response = ctx.util.request({
        method: "GET",
        url: ORIGINS[selectedRegion] + "/v1/users/me/balance",
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
        timeoutMs: 15000,
      })
    } catch {
      ctx.host.log.error("Moonshot balance request failed before receiving a response")
      throw "Moonshot balance request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(response.status)) {
      ctx.host.log.error("Moonshot balance request was rejected with HTTP " + response.status)
      throw "Moonshot API key was rejected. Check the key and region."
    }
    if (response.status < 200 || response.status >= 300) {
      ctx.host.log.error("Moonshot balance request returned HTTP " + response.status)
      throw "Moonshot balance request failed (HTTP " + response.status + "). Try again later."
    }

    const body = ctx.util.tryParseJson(response.bodyText)
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      ctx.host.log.error("Moonshot balance response is not a JSON object")
      throw "Moonshot balance response is invalid. Try again later."
    }
    if (body.code !== 0 || body.status !== true) {
      ctx.host.log.error("Moonshot balance API rejected the request with code " + String(body.code))
      throw "Moonshot could not return your balance. Check the key and region."
    }
    const data = body.data
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      ctx.host.log.error("Moonshot balance response has no data object")
      throw "Moonshot balance response is invalid. Try again later."
    }

    const available = amount(ctx, data, "available_balance")
    const cash = amount(ctx, data, "cash_balance")
    const voucher = amount(ctx, data, "voucher_balance")
    return {
      lines: [
        ctx.line.text({ label: "Available Balance", value: money(available, selectedRegion) }),
        ctx.line.text({ label: "Cash Balance", value: money(cash, selectedRegion) }),
        ctx.line.text({ label: "Voucher Balance", value: money(voucher, selectedRegion) }),
      ],
    }
  }

  globalThis.__openusage_plugin = { id: "moonshot", probe }
})()
