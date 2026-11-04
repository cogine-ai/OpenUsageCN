(function () {
  var { loadOAuthTokenCandidates, loadCachedToken, refreshAccessToken, loadAgyKeychainToken } = globalThis.__antigravityAuth
  var { buildModelLines, parseCloudCodeModels, probeCloudCode, probeAgyCloudCode } = globalThis.__antigravityQuota
  var CC_MODEL_BLACKLIST = globalThis.__antigravityQuota.blacklist
  var LS_SERVICE = "exa.language_server_pb.LanguageServerService"
  var LOGIN_MESSAGE = "Start Antigravity or run `agy` and try again."
  // --- LS discovery ---

  function discoverLs(ctx) {
    return ctx.host.ls.discover({
      processName: "language_server",
      markers: ["antigravity", "antigravity-ide"],
      csrfFlag: "--csrf_token",
      portFlag: "--extension_server_port",
    })
  }

  function discoverAgyLs(ctx) {
    return ctx.host.ls.discover({
      processName: "agy",
      markers: [],
      csrfFlag: "",
      portFlag: null,
    })
  }

  function probePort(ctx, scheme, port, csrf) {
    ctx.host.http.request({
      method: "POST",
      url: scheme + "://127.0.0.1:" + port + "/" + LS_SERVICE + "/GetUnleashData",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      bodyText: JSON.stringify({
        context: {
          properties: {
            devMode: "false",
            extensionVersion: "unknown",
            ide: "antigravity",
            ideVersion: "unknown",
            os: "macos",
          },
        },
      }),
      timeoutMs: 5000,
      dangerouslyIgnoreTls: scheme === "https",
    })
    // Any HTTP response means this port is alive (even 400 validation errors).
    return true
  }

  function findWorkingPort(ctx, discovery) {
    var ports = discovery.ports || []
    for (var i = 0; i < ports.length; i++) {
      var port = ports[i]
      // Try HTTPS first (LS may use self-signed cert), then HTTP
      try { if (probePort(ctx, "https", port, discovery.csrf)) return { port: port, scheme: "https" } } catch (e) { /* ignore */ }
      try { if (probePort(ctx, "http", port, discovery.csrf)) return { port: port, scheme: "http" } } catch (e) { /* ignore */ }
      ctx.host.log.info("port " + port + " probe failed on both schemes")
    }
    if (discovery.extensionPort) return { port: discovery.extensionPort, scheme: "http" }
    return null
  }

  function callLs(ctx, port, scheme, csrf, method, body) {
    var resp = ctx.host.http.request({
      method: "POST",
      url: scheme + "://127.0.0.1:" + port + "/" + LS_SERVICE + "/" + method,
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      bodyText: JSON.stringify(body || {}),
      timeoutMs: 10000,
      dangerouslyIgnoreTls: scheme === "https",
    })
    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("callLs " + method + " returned " + resp.status)
      return null
    }
    return ctx.util.tryParseJson(resp.bodyText)
  }

  // --- LS probe ---

  function probeDiscovery(ctx, discovery) {
    if (!discovery) return null

    var found = findWorkingPort(ctx, discovery)
    if (!found) return null

    ctx.host.log.info("using LS at " + found.scheme + "://127.0.0.1:" + found.port)

    var metadata = {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    }

    // Try GetUserStatus first, fall back to GetCommandModelConfigs
    var data = null
    try {
      data = callLs(ctx, found.port, found.scheme, discovery.csrf, "GetUserStatus", { metadata: metadata })
    } catch (e) {
      ctx.host.log.warn("GetUserStatus threw: " + String(e))
    }
    var hasUserStatus = data && data.userStatus

    if (!hasUserStatus) {
      ctx.host.log.warn("GetUserStatus failed, trying GetCommandModelConfigs")
      data = callLs(ctx, found.port, found.scheme, discovery.csrf, "GetCommandModelConfigs", { metadata: metadata })
    }

    // Parse model configs
    var configs
    if (hasUserStatus) {
      configs = (data.userStatus.cascadeModelConfigData || {}).clientModelConfigs || []
    } else if (data && data.clientModelConfigs) {
      configs = data.clientModelConfigs
    } else {
      return null
    }

    var filtered = []
    for (var j = 0; j < configs.length; j++) {
      var mid = configs[j].modelOrAlias && configs[j].modelOrAlias.model
      if (mid && CC_MODEL_BLACKLIST[mid]) continue
      filtered.push(configs[j])
    }

    var lines = buildModelLines(ctx, filtered)
    if (lines.length === 0) return null

    var plan = null
    if (hasUserStatus) {
      // Prefer userTier.name (Google's own subscription system) over the legacy
      // planInfo.planName field inherited from Windsurf/Codeium, which always
      // returns "Pro" for all paid tiers including Google AI Ultra.
      var ut = data.userStatus.userTier
      var userTierName =
        ut && typeof ut.name === "string" && ut.name.trim() ? ut.name.trim() : null
      if (userTierName) {
        plan = userTierName
      } else {
        var ps = data.userStatus.planStatus || {}
        var pi = ps.planInfo || {}
        plan =
          typeof pi.planName === "string" && pi.planName.trim() ? pi.planName.trim() : null
      }
    }

    return { plan: plan, lines: lines }
  }

  function probeLs(ctx) {
    return probeDiscovery(ctx, discoverLs(ctx))
  }

  function probeAgyLs(ctx) {
    return probeDiscovery(ctx, discoverAgyLs(ctx))
  }

  // --- Probe ---

  function probe(originalCtx) {
    var deadline = Date.now() + 25000
    var ctx = Object.assign({}, originalCtx, { host: Object.assign({}, originalCtx.host, {
      http: Object.assign({}, originalCtx.host.http, { request: function (options) {
        var remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error("Antigravity usage request timed out. Try again later.")
        return originalCtx.host.http.request(Object.assign({}, options, { timeoutMs: Math.min(options.timeoutMs || 15000, remaining) }))
      } })
    }) })
    var dbTokenCandidates = loadOAuthTokenCandidates(ctx)

    var tokens = []
    var nowSec = Math.floor(Date.now() / 1000)
    for (var i = 0; i < dbTokenCandidates.length; i++) {
      var dbTokens = dbTokenCandidates[i]
      if (dbTokens.accessToken && (!dbTokens.expirySeconds || dbTokens.expirySeconds > nowSec)) {
        if (tokens.indexOf(dbTokens.accessToken) === -1) tokens.push(dbTokens.accessToken)
      }
    }

    var cached = loadCachedToken(ctx)
    if (cached && tokens.indexOf(cached) === -1) tokens.push(cached)

    var ccData = null
    var sawSummaryAuthFailure = false
    function quotaForToken(token) {
      var summary = globalThis.__antigravitySummary.read(ctx, token)
      if (summary._authFailed) sawSummaryAuthFailure = true
      return summary.unsupported ? probeCloudCode(ctx, token) : summary
    }
    var sawAuthFailure = false
    for (var i = 0; i < tokens.length; i++) {
      var nextData = globalThis.__antigravitySummary.read(ctx, tokens[i])
      if (nextData.unsupported) continue
      if (nextData && !nextData._authFailed) {
        ccData = nextData
        break
      }
      if (nextData && nextData._authFailed) { sawAuthFailure = true; sawSummaryAuthFailure = true }
    }

    if (ccData && ccData.lines) return ccData
    if (!ccData && !sawAuthFailure) {
      var lsResult = probeLs(ctx)
      if (lsResult) return lsResult
      var agyLsResult = probeAgyLs(ctx)
      if (agyLsResult) return agyLsResult
    }

    if (!ccData && !sawAuthFailure) {
      for (var i = 0; i < tokens.length; i++) {
        var legacy = probeCloudCode(ctx, tokens[i])
        if (legacy && !legacy._authFailed) { ccData = legacy; break }
        if (legacy && legacy._authFailed) sawAuthFailure = true
      }
    }

    // Only refresh on evidence of an auth failure, or when there were no tokens to try.
    // probeCloudCode returns null for transient failures (5xx/timeouts); without this
    // guard a Cloud Code incident would trigger a Google OAuth refresh every probe cycle
    // instead of ~once per token lifetime — risking refresh-token throttling or rotation.
    if (!ccData && (sawAuthFailure || tokens.length === 0)) {
      var refreshTokens = []
      for (var j = 0; j < dbTokenCandidates.length; j++) {
        var refreshToken = dbTokenCandidates[j].refreshToken
        if (refreshToken && refreshTokens.indexOf(refreshToken) === -1) refreshTokens.push(refreshToken)
      }
      for (var k = 0; k < refreshTokens.length; k++) {
        var refreshed = refreshAccessToken(ctx, refreshTokens[k])
        if (!refreshed) continue
        var refreshedData = quotaForToken(refreshed)
        if (refreshedData && !refreshedData._authFailed) {
          ccData = refreshedData
          break
        }
        if (refreshedData && refreshedData._authFailed) ccData = refreshedData
      }
    }

    if (!ccData || ccData._authFailed) {
      var agyToken = loadAgyKeychainToken(ctx)
      if (agyToken) {
        var agySummary = globalThis.__antigravitySummary.read(ctx, agyToken)
        var agyResult = agySummary.unsupported ? probeAgyCloudCode(ctx, agyToken) : agySummary
        if (agyResult && !agyResult._authFailed) return agyResult
        if (agyResult && agyResult._authFailed) { ccData = agyResult; if (!agySummary.unsupported) sawSummaryAuthFailure = true }
      }
    }

    if (ccData && ccData.lines) return ccData
    if (ccData && !ccData._authFailed) {
      var configs = parseCloudCodeModels(ccData)
      var lines = buildModelLines(ctx, configs)
      if (lines.length > 0) return { plan: null, lines: lines }
    }

    if (Date.now() >= deadline) throw "Antigravity usage request timed out. Try again later."
    if (sawSummaryAuthFailure) {
      ctx.host.log.error("Antigravity quota token refused")
      throw "Antigravity sign-in expired. Open Antigravity and sign in again."
    }
    throw LOGIN_MESSAGE
  }

  globalThis.__openusage_plugin = { id: "antigravity", probe: probe }
})()
