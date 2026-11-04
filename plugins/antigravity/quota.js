(function () {
  var CLOUD_CODE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]
  var LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist"
  var FETCH_MODELS_PATH = "/v1internal:fetchAvailableModels"
  var RETRIEVE_QUOTA_PATH = "/v1internal:retrieveUserQuota"
  var CC_MODEL_BLACKLIST = {
    "MODEL_CHAT_20706": true,
    "MODEL_CHAT_23310": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE": true,
    "MODEL_GOOGLE_GEMINI_2_5_PRO": true,
    "MODEL_PLACEHOLDER_M19": true,
    "MODEL_PLACEHOLDER_M9": true,
    "MODEL_PLACEHOLDER_M12": true,
  }
  // --- Line builders ---

  function normalizeLabel(label) {
    // "Gemini 3 Pro (High)" -> "Gemini 3 Pro"
    return label.replace(/\s*\([^)]*\)\s*$/, "").trim()
  }

  function poolLabel(normalizedLabel) {
    var lower = normalizedLabel.toLowerCase()
    if (lower.indexOf("gemini") !== -1 && lower.indexOf("pro") !== -1) return "Gemini Pro"
    if (lower.indexOf("gemini") !== -1 && lower.indexOf("flash") !== -1) return "Gemini Flash"
    // All non-Gemini models (Claude, GPT-OSS, etc.) share a single quota pool
    return "Claude"
  }

  function modelSortKey(label) {
    var lower = label.toLowerCase()
    // Gemini Pro variants first, then other Gemini, then Claude Opus, then other Claude, then rest
    if (lower.indexOf("gemini") !== -1 && lower.indexOf("pro") !== -1) return "0a_" + label
    if (lower.indexOf("gemini") !== -1) return "0b_" + label
    if (lower.indexOf("claude") !== -1 && lower.indexOf("opus") !== -1) return "1a_" + label
    if (lower.indexOf("claude") !== -1) return "1b_" + label
    return "2_" + label
  }

  var QUOTA_PERIOD_MS = 5 * 60 * 60 * 1000 // 5 hours

  function modelLine(ctx, label, remainingFraction, resetTime) {
    var clamped = Math.max(0, Math.min(1, remainingFraction))
    var used = Math.round((1 - clamped) * 100)
    return ctx.line.progress({
      label: label,
      used: used,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: resetTime || undefined,
    })
  }

  function buildModelLines(ctx, configs) {
    var deduped = {}
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i]
      var label = (typeof c.label === "string") ? c.label.trim() : ""
      if (!label) continue
      var qi = c.quotaInfo
      var frac = qi && qi.remainingFraction
      if (typeof frac !== "number" || !Number.isFinite(frac)) continue
      var rtime = (qi && qi.resetTime) || undefined
      var pool = poolLabel(normalizeLabel(label))
      if (!deduped[pool] || frac < deduped[pool].remainingFraction) {
        deduped[pool] = {
          label: pool,
          remainingFraction: frac,
          resetTime: rtime,
        }
      }
    }

    var models = []
    var keys = Object.keys(deduped)
    for (var i = 0; i < keys.length; i++) {
      var m = deduped[keys[i]]
      m.sortKey = modelSortKey(m.label)
      models.push(m)
    }

    models.sort(function (a, b) {
      return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
    })

    var lines = []
    for (var i = 0; i < models.length; i++) {
      lines.push(modelLine(ctx, models[i].label, models[i].remainingFraction, models[i].resetTime))
    }
    return lines
  }

  // --- Cloud Code API ---

  function requestCloudCodeJson(ctx, path, token, userAgent, body) {
    for (var i = 0; i < CLOUD_CODE_URLS.length; i++) {
      try {
        var resp = ctx.host.http.request({
          method: "POST",
          url: CLOUD_CODE_URLS[i] + path,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            "User-Agent": userAgent || "antigravity",
          },
          bodyText: JSON.stringify(body || {}),
          timeoutMs: 15000,
        })
        if (!resp || typeof resp.status !== "number" || !Number.isFinite(resp.status)) {
          ctx.host.log.warn("Cloud Code returned invalid response shape (" + CLOUD_CODE_URLS[i] + ")")
          continue
        }
        if (ctx.util.isAuthStatus(resp.status)) return { _authFailed: true }
        if (resp.status >= 200 && resp.status < 300) {
          var json = ctx.util.tryParseJson(resp.bodyText)
          if (!json || typeof json !== "object") {
            ctx.host.log.warn("Cloud Code returned invalid JSON (" + CLOUD_CODE_URLS[i] + ")")
            continue
          }
          return json
        }
      } catch (e) {
        ctx.host.log.warn("Cloud Code request failed (" + CLOUD_CODE_URLS[i] + "): " + String(e))
      }
    }
    return null
  }

  function probeCloudCode(ctx, token, userAgent) {
    return requestCloudCodeJson(ctx, FETCH_MODELS_PATH, token, userAgent, {})
  }

  function parseCloudCodeModels(data) {
    var modelsObj = data && data.models
    if (!modelsObj || typeof modelsObj !== "object") return []
    var keys = Object.keys(modelsObj)
    var configs = []
    for (var i = 0; i < keys.length; i++) {
      var m = modelsObj[keys[i]]
      if (!m || typeof m !== "object") continue
      if (m.isInternal) continue
      var modelId = m.model || keys[i]
      if (CC_MODEL_BLACKLIST[modelId]) continue
      var displayName =
        (typeof m.displayName === "string" && m.displayName.trim()) ||
        (typeof m.label === "string" && m.label.trim()) ||
        ""
      if (!displayName) continue
      var qi = m.quotaInfo
      var frac = qi && qi.remainingFraction
      if (typeof frac !== "number" || !Number.isFinite(frac)) continue
      var rtime = (qi && qi.resetTime) || undefined
      configs.push({
        label: displayName,
        quotaInfo: { remainingFraction: frac, resetTime: rtime },
      })
    }
    return configs
  }

  function readAgyPlan(loadData) {
    var paidTier = loadData && loadData.paidTier
    if (paidTier && typeof paidTier.name === "string" && paidTier.name.trim()) {
      return paidTier.name.trim()
    }
    var currentTier = loadData && loadData.currentTier
    if (currentTier && typeof currentTier.name === "string" && currentTier.name.trim()) {
      return currentTier.name.trim()
    }
    return null
  }

  function parseAgyQuotaBuckets(data) {
    var buckets = data && data.buckets
    if (!Array.isArray(buckets)) return []
    var configs = []
    for (var i = 0; i < buckets.length; i++) {
      var bucket = buckets[i]
      if (!bucket || typeof bucket !== "object") continue
      var modelId = (typeof bucket.modelId === "string" && bucket.modelId.trim()) || ""
      if (!modelId) continue
      var frac = bucket.remainingFraction
      if (typeof frac !== "number" || !Number.isFinite(frac)) continue
      configs.push({
        label: modelId,
        quotaInfo: { remainingFraction: frac, resetTime: bucket.resetTime || undefined },
      })
    }
    return configs
  }

  function probeAgyCloudCode(ctx, token) {
    var loadData = requestCloudCodeJson(ctx, LOAD_CODE_ASSIST_PATH, token, "agy", {})
    if (!loadData || loadData._authFailed) return loadData

    var project =
      typeof loadData.cloudaicompanionProject === "string" && loadData.cloudaicompanionProject.trim()
        ? loadData.cloudaicompanionProject.trim()
        : null
    var quotaData = null
    if (project) {
      quotaData = requestCloudCodeJson(ctx, RETRIEVE_QUOTA_PATH, token, "agy", { project: project })
    }
    if (!quotaData || quotaData._authFailed) {
      quotaData = requestCloudCodeJson(ctx, RETRIEVE_QUOTA_PATH, token, "agy", {})
    }
    if (!quotaData || quotaData._authFailed) return quotaData

    var lines = buildModelLines(ctx, parseAgyQuotaBuckets(quotaData))
    if (lines.length === 0) return null
    return { plan: readAgyPlan(loadData), lines: lines }
  }


  globalThis.__antigravityQuota = { buildModelLines, parseCloudCodeModels, probeCloudCode, probeAgyCloudCode, blacklist: CC_MODEL_BLACKLIST }
})()
