(function () {
  const DEFAULT_CONFIG = {
    mode: "ok",
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

  function readConfig(ctx, configPath) {
    if (!ctx.host.fs.exists(configPath)) {
      try {
        ctx.host.fs.writeText(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2))
      } catch {
        // If this fails, let execution continue with defaults.
      }
      return DEFAULT_CONFIG
    }

    try {
      const text = ctx.host.fs.readText(configPath)
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== "object") return DEFAULT_CONFIG
      const mode = typeof parsed.mode === "string" ? parsed.mode : DEFAULT_CONFIG.mode
      return { mode }
    } catch {
      return DEFAULT_CONFIG
    }
  }

  function probe(ctx) {
    const configPath = ctx.app.pluginDataDir + "/config.json"
    const config = readConfig(ctx, configPath)
    const mode = String(config.mode || "ok")

    // Non-throwing modes should always include a “where to change this” hint.
    const hintLines = [
      lineBadge("Mode", mode, "#000000"),
      lineText("Config", configPath),
    ]

    if (mode === "ok") {
      return {
        lines: [
          ...hintLines,
          lineProgress("Percent", 42, 100, "percent", "#22c55e"),
          lineProgress("Dollars", 12.34, 100, "dollars", "#3b82f6"),
          lineText("Now", ctx.nowIso),
        ],
      }
    }

    if (mode === "throw") {
      throw new Error("mock plugin: thrown error")
    }

    if (mode === "reject") {
      return Promise.reject(new Error("mock plugin: rejected promise"))
    }

    if (mode === "unresolved_promise") {
      return new Promise(function () {
        // Intentionally never resolves/rejects.
      })
    }

    if (mode === "non_object") {
      return "not an object"
    }

    if (mode === "missing_lines") {
      return {}
    }

    if (mode === "unknown_line_type") {
      return {
        lines: [
          ...hintLines,
          { type: "nope", label: "Bad", value: "data" },
        ],
      }
    }

    if (mode === "fs_throw") {
      // Uncaught host FS exception -> host should report "probe() failed".
      ctx.host.fs.readText("/definitely/not/a/real/path-" + String(Date.now()))
      return { lines: hintLines }
    }

    if (mode === "http_throw") {
      // Invalid HTTP method -> host throws -> host should report "probe() failed".
      ctx.host.http.request({
        method: "NOPE_METHOD",
        url: "https://example.com/",
        timeoutMs: 1000,
      })
      return { lines: hintLines }
    }

    if (mode === "sqlite_throw") {
      // Dot-commands are blocked by host -> uncaught -> host should report "probe() failed".
      ctx.host.sqlite.query(ctx.app.appDataDir + "/does-not-matter.db", ".schema")
      return { lines: hintLines }
    }

    // Unknown mode: don’t throw; make it obvious.
    return {
      lines: [
        ...hintLines,
        lineBadge("Warning", "unknown mode: " + safeString(mode), "#f59e0b"),
      ],
    }
  }

  globalThis.__openusage_plugin = { id: "mock", probe }
})()

