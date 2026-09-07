type RecoveryKind = "credentials" | "login" | "permission" | "network" | "rate_limit" | "invalid_response" | "unknown"

type PluginRecovery = {
  kind: RecoveryKind
  title: string
  advice: string
  diagnostic: string
}

function safeDiagnostic(message: string): string {
  return message
    .replace(/https?:\/\/[^\s<>"`]+/gi, (value) => {
      try {
        const url = new URL(value)
        const hasSecrets = Boolean(url.username || url.password || url.search || url.hash)
        return `${url.origin}${url.pathname}${hasSecrets ? " [已隐藏]" : ""}`
      } catch {
        return "[链接已隐藏]"
      }
    })
    .replace(/(\bauthorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, "$1[已隐藏]")
    .replace(/\b(?:set-cookie|cookie)\s*:[^\r\n]+/gi, "Cookie: [已隐藏]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
    .replace(/(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|authorization|cookie|password|secret|token|key|access|refresh)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[已隐藏\]|[^\s,;}\]]+)/gi, "$1[已隐藏]")
    .replace(/\bsk[-_][A-Za-z0-9_-]+\b/g, "[已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已隐藏]")
}

function loginAdvice(providerId?: string): string {
  switch (providerId) {
    case "claude": return "请打开 Claude Code 完成登录，然后重试。"
    case "codex": return "请运行 `codex login` 完成登录，然后重试。"
    case "kimi": return "请运行 `kimi login` 完成登录，然后重试。"
    case "factory": return "请运行 `droid` 完成登录，然后重试。"
    case "opencode-go": return "请在 OpenCode 中重新连接 Go 账号，然后重试。"
    default: return "请在服务商应用重新登录，或在设置中更新登录凭据，然后重试。"
  }
}

export function getPluginRecovery(message: string, providerId?: string): PluginRecovery {
  const diagnostic = safeDiagnostic(message)
  const recovery = (kind: RecoveryKind, title: string, advice: string): PluginRecovery => ({ kind, title, advice, diagnostic })

  if (providerId === "codex" && message.includes("Windows requires Codex file storage:") && message.includes("cli_auth_credentials_store")) {
    return recovery("login", "需要文件登录凭据", '请在 Codex 的 `config.toml` 中设置 `cli_auth_credentials_store = "file"`，再运行 `codex login`，然后重试。')
  }
  if (/Claude Keychain credentials must be refreshed by Claude Code/i.test(message)) {
    return recovery("login", "需要更新登录", loginAdvice("claude"))
  }
  if (/credentials could not be read/i.test(message)) {
    return recovery("credentials", "无法读取登录凭据", "请检查服务商的本地登录文件和读取权限，然后重试。")
  }
  if (/no .*(?:api key|cookie|credentials?) found|missing (?:api key|credentials?)/i.test(message)) {
    const advice = /cookie/i.test(message)
      ? "请在服务商设置中补充 Cookie，然后重试。"
      : /api key/i.test(message)
        ? "请在服务商设置中补充 API Key，然后重试。"
        : loginAdvice(providerId)
    return recovery("credentials", "缺少连接凭据", advice)
  }
  if (/not logged in|OpenCode Go not detected\. Log in with OpenCode Go first/i.test(message)) {
    return recovery("login", "尚未登录", loginAdvice(providerId))
  }
  if (/(?:session|token) expired|key was rejected|api key invalid|credentials are invalid|invalid (?:auth file|credentials?)|\bHTTP\s*401\b|\bunauthorized\b/i.test(message)) {
    return recovery("login", /(?:session|token) expired/i.test(message) ? "登录已过期" : "登录凭据失效", loginAdvice(providerId))
  }
  if (/no .*subscription on this key/i.test(message)) {
    return recovery("permission", "账号订阅不可用", "请在服务商应用检查当前账号和订阅，再重试。")
  }
  if (/\bHTTP\s*403\b|permission denied|access (?:was )?denied|\bforbidden\b/i.test(message)) {
    return recovery("permission", "访问被拒绝", "请检查账号权限和凭据读取权限，然后重试。")
  }
  if (/\bHTTP\s*429\b|too many requests|is limiting requests|rate limit(?:ed| exceeded)/i.test(message)) {
    return recovery("rate_limit", "请求过于频繁", "请稍后再重试，避免连续刷新。")
  }
  if (/check your connection|unable to connect|request timed out|network (?:error|request failed)|connection refused|fetch failed|\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/i.test(message)) {
    return recovery("network", "连接失败", "请检查网络和代理设置，然后重试。")
  }
  if (/(?:usage|quota|response|data).*(?:invalid|incomplete|missing .*fields)|invalid JSON|could not parse usage data/i.test(message)) {
    return recovery("invalid_response", "返回的数据格式异常", "请稍后重试；若持续出现，请收集日志反馈。")
  }
  return recovery("unknown", "暂时无法更新", "原因尚未识别。请重试；若仍失败，可查看诊断详情并收集日志。")
}
