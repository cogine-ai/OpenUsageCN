(function () {
  const DEFAULT_CONFIG = {
    // By default this plugin is intentionally non-deterministic / failure-prone.
    // If you want to pin a specific mode, set { pinned: true, mode: "..." }.
    mode: "chaos",
    pinned: false,
  }

  function lineText(label, value, color) {
    const line = { type: "text", label, value }
    if (color) line.color = color
    return line
  }

  function lineProgress(label, value, max, unit, color) {
    const line = { type: "progress", label, value, max }
    if (unit) line.unit = unit
    if (color) line.color = color
    return line
  }

  function lineBadge(label, text, color) {
    const line = { type: "badge", label, text }
    if (color) line.color = color
    return line
  }

  function safeString(value) {
    try {
      if (value === null) return "null"
      if (value === undefined) return "undefined"
      if (typeof value === "string") return value
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  function logInfo(ctx, message) {
    try {
      ctx.host.log.info("[mock] " + message)
    } catch {}
  }

  function logWarn(ctx, message) {
    try {
      ctx.host.log.warn("[mock] " + message)
    } catch {}
  }

  function readJson(ctx, path) {
    try {
      if (!ctx.host.fs.exists(path)) return null
      const text = ctx.host.fs.readText(path)
      return JSON.parse(text)
    } catch (e) {
      logWarn(ctx, "readJson failed for " + path + ": " + safeString(e))
      return null
    }
  }

  function writeJson(ctx, path, value) {
    try {
      ctx.host.fs.writeText(path, JSON.stringify(value, null, 2))
    } catch (e) {
      logWarn(ctx, "writeJson failed for " + path + ": " + safeString(e))
    }
  }

  function readConfig(ctx, configPath) {
    const parsed = readJson(ctx, configPath)

    // Initialize config on first run.
    if (!parsed || typeof parsed !== "object") {
      writeJson(ctx, configPath, DEFAULT_CONFIG)
      logInfo(ctx, "config initialized at " + configPath)
      return DEFAULT_CONFIG
    }

    const pinned = typeof parsed.pinned === "boolean" ? parsed.pinned : false
    const mode = typeof parsed.mode === "string" ? parsed.mode : DEFAULT_CONFIG.mode

    // Auto-migrate legacy configs that were auto-created as { mode: "ok" }.
    if (!pinned && mode === "ok") {
      writeJson(ctx, configPath, DEFAULT_CONFIG)
      logInfo(ctx, "legacy config migrated at " + configPath)
      return DEFAULT_CONFIG
    }

    return { mode, pinned }
  }

  function chooseChaosCase(ctx, pluginDataDir) {
    const statePath = pluginDataDir + "/state.json"
    const state = readJson(ctx, statePath)
    const prevCounter = Number(state && state.counter)
    const counter = Number.isFinite(prevCounter) && prevCounter >= 0 ? prevCounter + 1 : 0

    const cases = [
      // "Looks fine" baseline
      "ok",

      // Subtle API misuse that doesn't crash but yields wrong UI
      "progress_max_na",
      "progress_value_string",
      "progress_value_nan",
      "badge_text_number",

      // Hard schema issues (host returns a single Error badge)
      "lines_not_array",
      "line_not_object",

      // Explicit runtime failures
      "throw",
      "reject",
      "unresolved_promise",
      "http_throw",
      "sqlite_throw",
    ]

    const idx = counter % cases.length
    const picked = cases[idx]

    writeJson(ctx, statePath, { counter, picked, nowIso: ctx.nowIso })
    logInfo(ctx, "chaos case picked: " + picked + " (counter=" + String(counter) + ")")
    return { counter, picked }
  }

  function writeLastCase(ctx, pluginDataDir, picked) {
    writeJson(ctx, pluginDataDir + "/last_case.json", { picked, nowIso: ctx.nowIso })
  }

  function probe(ctx) {
    const configPath = ctx.app.pluginDataDir + "/config.json"
    const config = readConfig(ctx, configPath)
    const pinned = !!config.pinned
    const requestedMode = String(config.mode || DEFAULT_CONFIG.mode)
    const effectiveMode = pinned ? requestedMode : "chaos"
    logInfo(
      ctx,
      "probe start (pinned=" + String(pinned) + ", requested=" + requestedMode + ", effective=" + effectiveMode + ")"
    )

    let mode = effectiveMode
    if (effectiveMode === "chaos") {
      const picked = chooseChaosCase(ctx, ctx.app.pluginDataDir).picked
      writeLastCase(ctx, ctx.app.pluginDataDir, picked)
      mode = picked
    }
    logInfo(ctx, "mode selected: " + String(mode))

    // Non-throwing modes should always include a “where to change this” hint.
    const hintLines = [
      lineBadge("Mode", effectiveMode, "#000000"),
      lineText("Config", configPath),
    ]

    if (mode === "ok") {
      logInfo(ctx, "mode ok")
      return {
        lines: [
          ...hintLines,
          effectiveMode === "chaos" ? lineBadge("Case", "ok", "#000000") : null,
          lineProgress("Percent", 42, 100, "percent", "#22c55e"),
          lineProgress("Dollars", 12.34, 100, "dollars", "#3b82f6"),
          lineText("Now", ctx.nowIso),
        ].filter(Boolean),
      }
    }

    if (mode === "throw") {
      logWarn(ctx, "mode throw: about to throw")
      throw new Error("mock plugin: thrown error")
    }

    if (mode === "reject") {
      logWarn(ctx, "mode reject: returning rejected promise")
      return Promise.reject(new Error("mock plugin: rejected promise"))
    }

    if (mode === "unresolved_promise") {
      logWarn(ctx, "mode unresolved_promise: returning never-resolving promise")
      return new Promise(function () {
        // Intentionally never resolves/rejects.
      })
    }

    if (mode === "non_object") {
      logWarn(ctx, "mode non_object: returning non-object")
      return "not an object"
    }

    if (mode === "missing_lines") {
      logWarn(ctx, "mode missing_lines: returning empty object")
      return {}
    }

    if (mode === "unknown_line_type") {
      logWarn(ctx, "mode unknown_line_type: returning invalid line")
      return {
        lines: [
          ...hintLines,
          { type: "nope", label: "Bad", value: "data" },
        ],
      }
    }

    if (mode === "lines_not_array") {
      logWarn(ctx, "mode lines_not_array: returning lines as string")
      // Host expects `lines` to be an Array. This becomes "missing lines".
      return {
        lines: "nope",
      }
    }

    if (mode === "line_not_object") {
      logWarn(ctx, "mode line_not_object: returning non-object line")
      // Host expects each line to be an object. This becomes "invalid line at index N".
      return {
        lines: [
          ...hintLines,
          "definitely not an object",
        ],
      }
    }

    if (mode === "progress_max_na") {
      logWarn(ctx, "mode progress_max_na: max is not numeric")
      // Common plugin bug: max is not a number (e.g. "N/A"). Host coerces to 0.0.
      // UI will show "42%" but bar stays empty because max <= 0.
      return {
        lines: [
          ...hintLines,
          lineBadge("Case", "progress.max = \"N/A\" (string)", "#000000"),
          { type: "progress", label: "Percent", value: 42, max: "N/A", unit: "percent", color: "#ef4444" },
        ],
      }
    }

    if (mode === "progress_value_string") {
      logWarn(ctx, "mode progress_value_string: value is string")
      // Common plugin bug: value is a string. Host coerces to 0.0.
      // UI will show 0% even though the plugin tried to say "42".
      return {
        lines: [
          ...hintLines,
          lineBadge("Case", "progress.value = \"42\" (string)", "#000000"),
          { type: "progress", label: "Percent", value: "42", max: 100, unit: "percent", color: "#ef4444" },
        ],
      }
    }

    if (mode === "progress_value_nan") {
      logWarn(ctx, "mode progress_value_nan: value is NaN")
      // Common plugin bug: value is NaN. Host detects non-finite -> value=-1, max=0.
      // UI shows N/A.
      return {
        lines: [
          ...hintLines,
          lineBadge("Case", "progress.value = NaN", "#000000"),
          { type: "progress", label: "Percent", value: 0 / 0, max: 100, unit: "percent", color: "#ef4444" },
        ],
      }
    }

    if (mode === "badge_text_number") {
      logWarn(ctx, "mode badge_text_number: badge.text is number")
      // Common plugin bug: badge.text isn't a string. Host reads empty string.
      return {
        lines: [
          ...hintLines,
          lineBadge("Case", "badge.text = 123 (number)", "#000000"),
          { type: "badge", label: "Status", text: 123, color: "#ef4444" },
        ],
      }
    }

    if (mode === "fs_throw") {
      logWarn(ctx, "mode fs_throw: about to throw from fs")
      // Uncaught host FS exception -> host should report "probe() failed".
      ctx.host.fs.readText("/definitely/not/a/real/path-" + String(Date.now()))
      return { lines: hintLines }
    }

    if (mode === "http_throw") {
      logWarn(ctx, "mode http_throw: about to throw from http")
      // Invalid HTTP method -> host throws -> host should report "probe() failed".
      ctx.host.http.request({
        method: "NOPE_METHOD",
        url: "https://example.com/",
        timeoutMs: 1000,
      })
      return { lines: hintLines }
    }

    if (mode === "sqlite_throw") {
      logWarn(ctx, "mode sqlite_throw: about to throw from sqlite")
      // Dot-commands are blocked by host -> uncaught -> host should report "probe() failed".
      ctx.host.sqlite.query(ctx.app.appDataDir + "/does-not-matter.db", ".schema")
      return { lines: hintLines }
    }

    // Unknown mode: don’t throw; make it obvious.
    logWarn(ctx, "mode unknown: " + safeString(mode))
    return {
      lines: [
        ...hintLines,
        lineBadge("Warning", "unknown mode: " + safeString(mode), "#f59e0b"),
      ],
    }
  }

  globalThis.__openusage_plugin = { id: "mock", probe }
})()

