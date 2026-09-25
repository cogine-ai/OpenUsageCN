(function () {
  const SETTINGS_URL = "https://ollama.com/settings"
  const USAGE_LABELS = ["Monthly usage", "Session usage", "Hourly usage", "Weekly usage"]
  const SESSION_COOKIE_NAMES = [
    "session",
    "__Secure-session",
    "ollama_session",
    "__Host-ollama_session",
    "wos-session",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
  ]

  function isSessionCookie(name) {
    return SESSION_COOKIE_NAMES.includes(name) ||
      name.startsWith("__Secure-next-auth.session-token.") ||
      name.startsWith("next-auth.session-token.")
  }

  function normalizeCookie(raw) {
    if (typeof raw !== "string") return null
    const value = raw.trim().replace(/^Cookie:\s*/i, "")
    if (!value || /[\r\n\u0000-\u001f\u007f]/.test(value)) return null

    const pairs = value.split(";").map((part) => part.trim()).filter(Boolean)
    if (!pairs.length || !pairs.every((part) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*$/.test(part))) {
      return null
    }
    if (!pairs.some((part) => {
      const equals = part.indexOf("=")
      return isSessionCookie(part.slice(0, equals)) && part.slice(equals + 1).trim().length > 0
    })) return null
    return pairs.join("; ")
  }

  function loadCookie(ctx) {
    let raw
    try {
      raw = ctx.host.config.get("cookieHeader") || ctx.host.env.get("OLLAMA_CLOUD_COOKIE")
    } catch (error) {
      ctx.host.log.error("Could not read Ollama Cloud cookie configuration")
      throw "Could not read Ollama Cloud settings. Try again."
    }
    if (raw == null || String(raw).trim() === "") {
      throw "Ollama Cloud needs a signed-in browser Cookie header. Add it in Settings or set OLLAMA_CLOUD_COOKIE."
    }
    const cookie = normalizeCookie(raw)
    if (!cookie) {
      ctx.host.log.error("Ollama Cloud Cookie header is invalid or has no recognized session cookie")
      throw "Ollama Cloud Cookie header is invalid. Copy it from a signed-in ollama.com/settings request."
    }
    return cookie
  }

  function usageWindow(html, label) {
    const start = html.indexOf(label)
    if (start < 0) return null
    const tail = html.slice(start + label.length)
    const next = USAGE_LABELS.filter((candidate) => candidate !== label)
      .map((candidate) => tail.indexOf(candidate)).filter((index) => index >= 0)
    return tail.slice(0, Math.min(4000, next.length ? Math.min(...next) : 4000))
  }

  function usedPercent(window) {
    const explicit = /([0-9]+(?:\.[0-9]+)?)\s*%\s*used/i.exec(window)
    if (explicit && Number.isFinite(Number(explicit[1]))) return Number(explicit[1])

    const amount = "((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?)"
    const dollars = new RegExp("\\$" + amount + "\\s+of\\s+\\$" + amount + "\\s+used", "i").exec(window)
    if (dollars) {
      const used = Number(dollars[1].replace(/,/g, ""))
      const limit = Number(dollars[2].replace(/,/g, ""))
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) return used / limit * 100
    }

    const width = /width:\s*([0-9]+(?:\.[0-9]+)?)%/i.exec(window)
    return width && Number.isFinite(Number(width[1])) ? Number(width[1]) : null
  }

  function usageBlock(html, label) {
    const window = usageWindow(html, label)
    if (window === null) return null
    const percent = usedPercent(window)
    if (percent === null || percent < 0) return null
    const reset = /data-time="([^"]+)"/.exec(window)
    const date = reset && new Date(reset[1])
    return {
      percent: Math.min(100, percent),
      resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined,
    }
  }

  function signedOut(html) {
    const lower = html.toLowerCase()
    const hasSignInHeading = lower.includes("sign in to ollama") || lower.includes("log in to ollama")
    const hasAuthRoute = lower.includes("/api/auth/signin") || lower.includes("/auth/signin")
    const hasLoginRoute = /(?:action|href)=["']\/(?:login|signin)["']/.test(lower)
    const hasPasswordField = /(?:type|name)=["']password["']/.test(lower)
    const hasEmailField = /(?:type|name)=["']email["']/.test(lower)
    const hasForm = lower.includes("<form")
    return hasForm && ((hasSignInHeading && (hasEmailField || hasPasswordField || hasAuthRoute || hasLoginRoute)) ||
      hasAuthRoute || hasLoginRoute || (hasPasswordField && hasEmailField))
  }

  function progressLine(ctx, label, block) {
    if (!block) return null
    return ctx.line.progress({
      label,
      used: block.percent,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: block.resetsAt,
    })
  }

  function probe(ctx) {
    const cookie = loadCookie(ctx)
    let response
    try {
      response = ctx.util.request({
        method: "GET",
        url: SETTINGS_URL,
        headers: {
          Cookie: cookie,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: "https://ollama.com",
          Referer: SETTINGS_URL,
        },
        timeoutMs: 15000,
      })
    } catch (error) {
      ctx.host.log.error("Ollama Cloud usage network request failed")
      throw "Could not reach Ollama Cloud. Check your connection."
    }

    if (ctx.util.isAuthStatus(response.status) || (response.status >= 300 && response.status < 400)) {
      ctx.host.log.warn("Ollama Cloud session rejected: HTTP " + response.status)
      throw "Ollama Cloud session expired. Sign in at ollama.com and copy a fresh Cookie header."
    }
    if (response.status < 200 || response.status >= 300) {
      ctx.host.log.error("Ollama Cloud usage request returned HTTP " + response.status)
      throw "Ollama Cloud usage request failed (HTTP " + response.status + "). Try again later."
    }

    const html = response.bodyText
    if (typeof html !== "string") {
      ctx.host.log.error("Ollama Cloud settings response is not HTML text")
      throw "Ollama Cloud usage page changed. Update the app or try again later."
    }

    const lines = [
      progressLine(ctx, "Monthly", usageBlock(html, "Monthly usage")),
      progressLine(ctx, "Session", usageBlock(html, "Session usage") || usageBlock(html, "Hourly usage")),
      progressLine(ctx, "Weekly", usageBlock(html, "Weekly usage")),
    ].filter(Boolean)
    if (!lines.length) {
      if (signedOut(html)) {
        ctx.host.log.warn("Ollama Cloud settings page shows a sign-in form")
        throw "Ollama Cloud session expired. Sign in at ollama.com and copy a fresh Cookie header."
      }
      ctx.host.log.error("Ollama Cloud usage response has no supported quota windows")
      throw "Ollama Cloud returned no supported usage windows. Check your account usage page."
    }
    return { lines }
  }

  globalThis.__openusage_plugin = { id: "ollama", probe }
})()
