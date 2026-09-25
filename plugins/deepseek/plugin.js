(function () {
  const BALANCE_URL = "https://api.deepseek.com/user/balance"

  function loadApiKey(ctx) {
    const configured = ctx.host.config.get("apiKey")
    if (typeof configured === "string" && configured.trim()) return configured.trim()

    const fromEnv = ctx.host.env.get("DEEPSEEK_API_KEY")
    return typeof fromEnv === "string" && fromEnv.trim() ? fromEnv.trim() : null
  }

  function invalidResponse(ctx, reason) {
    ctx.host.log.error("DeepSeek balance response invalid: " + reason)
    throw "Balance response invalid. Try again later."
  }

  function parseAmount(ctx, value, field) {
    if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) {
      invalidResponse(ctx, field + " is not a decimal string")
    }
    const amount = Number(value)
    if (!Number.isFinite(amount)) invalidResponse(ctx, field + " is not finite")
    return amount
  }

  function formatAmount(currency, amount) {
    const symbol = currency === "CNY" ? "¥" : "$"
    return (amount < 0 ? "-" : "") + symbol + Math.abs(amount).toFixed(2)
  }

  function fetchBalance(ctx, apiKey) {
    let response
    try {
      response = ctx.util.request({
        method: "GET",
        url: BALANCE_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 15000,
      })
    } catch (_) {
      ctx.host.log.error("DeepSeek balance request failed")
      throw "Balance request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(response.status)) {
      ctx.host.log.error("DeepSeek balance request rejected the API key (HTTP " + response.status + ")")
      throw "DeepSeek API key invalid. Check your API key."
    }
    if (response.status < 200 || response.status >= 300) {
      ctx.host.log.error("DeepSeek balance request failed (HTTP " + response.status + ")")
      throw "Balance request failed (HTTP " + response.status + "). Try again later."
    }

    const data = ctx.util.tryParseJson(response.bodyText)
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      invalidResponse(ctx, "invalid JSON object")
    }
    if (typeof data.is_available !== "boolean" || !Array.isArray(data.balance_infos)) {
      invalidResponse(ctx, "missing availability or balance list")
    }
    return data
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      ctx.host.log.error("DeepSeek API key is not configured")
      throw "No DeepSeek API key found. Add it in Settings or set DEEPSEEK_API_KEY."
    }

    const data = fetchBalance(ctx, apiKey)
    const lines = [ctx.line.badge({
      label: "API Access",
      text: data.is_available ? "Available" : "Unavailable",
      color: data.is_available ? "#16a34a" : "#ef4444",
    })]
    const seen = new Set()
    for (const info of data.balance_infos) {
      if (!info || typeof info !== "object" || Array.isArray(info)) {
        invalidResponse(ctx, "balance entry is not an object")
      }
      const currency = info.currency
      if ((currency !== "CNY" && currency !== "USD") || seen.has(currency)) {
        invalidResponse(ctx, "unsupported or duplicate balance currency")
      }
      seen.add(currency)
      const total = parseAmount(ctx, info.total_balance, currency + " total_balance")
      const granted = parseAmount(ctx, info.granted_balance, currency + " granted_balance")
      const toppedUp = parseAmount(ctx, info.topped_up_balance, currency + " topped_up_balance")
      lines.push(ctx.line.text({ label: currency + " Balance", value: formatAmount(currency, total) }))
      lines.push(ctx.line.text({ label: currency + " Granted", value: formatAmount(currency, granted) }))
      lines.push(ctx.line.text({ label: currency + " Topped Up", value: formatAmount(currency, toppedUp) }))
    }
    if (data.is_available && seen.size === 0) {
      invalidResponse(ctx, "available account has no balance entries")
    }
    return { lines }
  }

  globalThis.__openusage_plugin = { id: "deepseek", probe }
})()
