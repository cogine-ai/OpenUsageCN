(function () {
  const DEFAULT_DB = "~/Library/Application Support/kiro-cli/data.sqlite3"
  const ENDPOINTS = {
    "us-east-1": "https://codewhisperer.us-east-1.amazonaws.com/",
    "eu-central-1": "https://q.eu-central-1.amazonaws.com/",
  }
  function fail(ctx, reason, message) {
    ctx.host.log.error("Kiro CLI usage failed: " + reason)
    throw message
  }
  function invalid(ctx) {
    fail(ctx, "invalid usage response", "Kiro CLI usage data is incomplete. Try again later.")
  }
  function path(ctx) {
    const raw = ctx.host.env.get("KIRO_DATA_DIR")
    if (typeof raw === "string" && raw.trim()) {
      if (/[\x00-\x1f\x7f]/.test(raw)) fail(ctx, "invalid data directory", "Check the KIRO_DATA_DIR directory and try again.")
      return raw.trim().replace(/\/+$/, "") + "/data.sqlite3"
    }
    if (ctx.app.platform === "macos" || ctx.app.platform === "darwin") return DEFAULT_DB
    const xdg = ctx.host.env.get("XDG_DATA_HOME")
    if (typeof xdg === "string" && /[\x00-\x1f\x7f]/.test(xdg)) fail(ctx, "invalid data directory", "Check the XDG_DATA_HOME directory and try again.")
    const home = typeof xdg === "string" && xdg.trim() ? xdg.trim().replace(/\/+$/, "") : "~/.local/share"
    return home + "/kiro-cli/data.sqlite3"
  }
  function value(ctx, database, sql) {
    let rows
    try { rows = ctx.util.tryParseJson(ctx.host.sqlite.queryReadOnly(database, sql)) }
    catch (_) { fail(ctx, "database read", "Kiro CLI sign-in data could not be read. Open Kiro CLI and try again.") }
    if (!Array.isArray(rows) || rows.length > 1) fail(ctx, "invalid database result", "Kiro CLI sign-in data is invalid. Run kiro-cli login again.")
    if (!rows.length) return null
    const parsed = ctx.util.tryParseJson(rows[0] && rows[0].value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(ctx, "invalid stored identity", "Kiro CLI sign-in data is invalid. Run kiro-cli login again.")
    return parsed
  }
  function identity(ctx, database) {
    const token = value(ctx, database, "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token' LIMIT 2;")
    if (!token || typeof token.access_token !== "string" || !token.access_token || /[\x00-\x20\x7f]/.test(token.access_token)) {
      fail(ctx, "missing access token", "Run kiro-cli login, then refresh Kiro usage.")
    }
    const profile = value(ctx, database, "SELECT value FROM state WHERE key = 'api.codewhisperer.profile' LIMIT 2;")
    if (!profile) return { accessToken: token.access_token, profileArn: null, endpoint: ENDPOINTS["us-east-1"] }
    const arn = profile.arn
    const parts = typeof arn === "string" ? arn.split(":") : []
    if (parts.length !== 6 || parts[0] !== "arn" || parts[1] !== "aws" || parts[2] !== "codewhisperer" ||
        !/^profile\/.+/.test(parts[5]) || /[\s\x00-\x1f\x7f]/.test(arn) || !Object.prototype.hasOwnProperty.call(ENDPOINTS, parts[3])) {
      fail(ctx, "unsupported profile", "Kiro CLI profile is invalid or its region is unsupported. Check your CLI sign-in.")
    }
    return { accessToken: token.access_token, profileArn: arn, endpoint: ENDPOINTS[parts[3]] }
  }
  function validNumber(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 }
  function read(ctx) {
    const database = path(ctx)
    try { if (!ctx.host.fs.existsStrict(database)) return null }
    catch (_) { fail(ctx, "database access", "Kiro CLI sign-in data could not be read. Open Kiro CLI and try again.") }
    const selected = identity(ctx, database)
    let response
    try {
      response = ctx.util.request({
        method: "POST", url: selected.endpoint,
        headers: { Authorization: "Bearer " + selected.accessToken, "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits" },
        bodyText: JSON.stringify(selected.profileArn ? { profileArn: selected.profileArn } : {}), timeoutMs: 10000,
      })
    } catch (_) { fail(ctx, "network request", "Kiro CLI usage request failed. Check your connection.") }
    if (response.status === 401) fail(ctx, "authentication rejected", "Kiro CLI session expired. Run kiro-cli login again.")
    if (response.status === 403) fail(ctx, "access denied", "Kiro CLI denied access to usage data. Check your CLI account.")
    if (response.status === 429) fail(ctx, "rate limited", "Kiro CLI requests are rate limited. Try again later.")
    if (response.status !== 200) fail(ctx, "server response", "Kiro CLI usage request failed. Try again later.")
    const current = identity(ctx, database)
    if (path(ctx) !== database || current.accessToken !== selected.accessToken || current.profileArn !== selected.profileArn) {
      fail(ctx, "connection changed", "Kiro CLI connection changed. Refresh usage.")
    }
    const data = ctx.util.tryParseJson(response.bodyText)
    if (!data || !Array.isArray(data.usageBreakdownList)) invalid(ctx)
    const credits = data.usageBreakdownList.filter((item) => item && item.resourceType === "CREDIT")
    if (credits.length !== 1) invalid(ctx)
    const credit = credits[0]
    if (!validNumber(credit.currentUsageWithPrecision) || !validNumber(credit.usageLimitWithPrecision)) invalid(ctx)
    const overage = credit.currentOveragesWithPrecision === undefined ? 0 : credit.currentOveragesWithPrecision
    if (!validNumber(overage) || overage > credit.currentUsageWithPrecision) invalid(ctx)
    if (credit.overageCapWithPrecision !== undefined && !validNumber(credit.overageCapWithPrecision)) invalid(ctx)
    if (credit.bonuses !== undefined && !Array.isArray(credit.bonuses)) invalid(ctx)
    const trial = credit.freeTrialInfo || credit.freeTrialUsage
    const trialUsed = trial && (trial.currentUsageWithPrecision === undefined ? trial.currentUsage : trial.currentUsageWithPrecision)
    const trialLimit = trial && (trial.usageLimitWithPrecision === undefined ? trial.usageLimit : trial.usageLimitWithPrecision)
    const activeTrial = trial && trial.freeTrialStatus === "ACTIVE" && validNumber(trialUsed) && validNumber(trialLimit) && trialLimit > 0
    if (!(credit.bonuses && credit.bonuses.length) && !activeTrial && credit.currentUsageWithPrecision - overage > credit.usageLimitWithPrecision) invalid(ctx)
    const reset = credit.nextDateReset === undefined ? data.nextDateReset : credit.nextDateReset
    if (reset !== undefined && (typeof reset !== "number" || !Number.isFinite(reset) || reset < 1000000000 || reset > 4102444800)) invalid(ctx)
    // This branch never refreshes or writes the CLI-owned token, and never reads desktop usage.
    return data
  }
  globalThis.__openusage_kiro_cli = { read }
})()
