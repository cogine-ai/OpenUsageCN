type RecoveryKind = "credentials" | "login" | "permission" | "network" | "rate_limit" | "invalid_response" | "unknown"

export type PluginRecovery = {
  action?: "config" | "accounts" | "local" | "retry"
  actionLabel?: string
  focusField?: string
  kind: RecoveryKind
  title: string
  advice: string
  diagnostic: string
}

/** Hide credential-bearing parts before exposing diagnostic details in the interface. */
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
    .replace(/\bdca:[A-Za-z0-9._~+\/-]+=*/gi, "[已隐藏]")
    .replace(/\bsk[-_][A-Za-z0-9_-]+\b/g, "[已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已隐藏]")
}

/** Recognize only CLI authentication messages whose supported repair is a local login. */
export function isKiroCliLoginError(message: string): boolean {
  return [
    "Run kiro-cli login, then refresh Kiro usage.",
    "Kiro CLI session expired. Run kiro-cli login again.",
    "Kiro CLI sign-in data is invalid. Run kiro-cli login again.",
  ].includes(message)
}

/** Use known provider login steps; arbitrary error text cannot supply an executable command. */
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

/** Match actionable failures to supported recovery routes while preserving sanitized diagnostics. */
export function getPluginRecovery(message: string, providerId?: string, capabilities?: { config?: { fields: { id: string; type: string; visibleWhen?: {field:string;values:string[]} }[] }; accountSupport?: unknown }): PluginRecovery {
  const diagnostic = safeDiagnostic(message)
  /** Choose an available recovery entry, keeping Claude local credential failures on local login. */
  const recovery = (kind: RecoveryKind, title: string, advice: string): PluginRecovery => {
    const localReadFailure = /credentials could not be read|(?:file|keychain|local).*permission|EACCES/i.test(message)
    const claudeLocalLogin = providerId === "claude" && /not logged in|(?:session|token) expired|Claude Keychain credentials must be refreshed by Claude Code/i.test(message)
    const secrets = capabilities?.config?.fields.filter((field) => field.type === "secret") ?? []
    const keys = secrets.filter((field) => /key/i.test(field.id))
    const alternatives = keys.length > 1 && keys.every((field) => field.visibleWhen?.field === keys[0].visibleWhen?.field && field.visibleWhen)
    const credentialField = /team id/i.test(message) ? capabilities?.config?.fields.find((field) => field.id === "teamId") : /cookie/i.test(message) ? secrets.find((field) => /cookie/i.test(field.id)) : alternatives ? undefined : keys[0] ?? secrets[0]
    const action = localReadFailure || claudeLocalLogin || kind === "permission" ? "local" : ["credentials", "login"].includes(kind)
      ? secrets.length ? "config" : capabilities?.accountSupport ? "accounts" : ["claude", "codex", "kimi", "factory", "opencode-go", "copilot", "grok", "gemini", "kiro", "amp", "antigravity", "perplexity"].includes(providerId ?? "") ? "local" : "retry"
      : "retry"
    return { kind, title, advice, diagnostic, action, focusField: credentialField?.id,
      actionLabel: action === "config" ? kind === "login" ? "更新凭据" : "连接账号" : action === "accounts" ? "重新连接" : action === "local" ? localReadFailure ? "检查读取权限" : kind === "permission" ? "检查账号权限" : "连接本机账号" : "重试" }
  }

  /** Keep provider-specific repair steps on their declared connection fields. */
  const configure = (kind: RecoveryKind, title: string, advice: string, focusField?: string): PluginRecovery => ({
    ...recovery(kind, title, advice), action: "config", actionLabel: "更新连接", focusField,
  })
  if (providerId === "muse" && /Connect Muse Code with Meta|Muse Code (?:connection is invalid|session expired)/i.test(message)) {
    return { ...configure("login", "需要连接 Meta 账号", "请在连接页完成 Meta 授权，再检查 Muse Code 用量。"), actionLabel: "连接 Meta 账号" }
  }
  if (providerId === "claude-platform" && /Multiple Claude Platform API organizations|configured Claude Platform API organization is unavailable|Claude Platform Organization ID is invalid/i.test(message)) {
    return configure("credentials", "需要选择 API 组织", "请填写当前 Console API 组织的 Organization ID，然后检查连接。", "organizationId")
  }
  if (providerId === "workbuddy" && /Cookie and matching User-Agent|User-Agent does not match/i.test(message)) {
    return configure("credentials", "需要匹配的会话凭据", "请更新同一次 WorkBuddy 账单请求的 Cookie 和 User-Agent。")
  }
  if (providerId === "litellm" && /Proxy URL is invalid/i.test(message)) {
    return configure("credentials", "需要有效代理地址", "请填写有效的 LiteLLM 代理地址，然后检查连接。", "baseUrl")
  }
  if (providerId === "siliconflow" && /Choose China or International/i.test(message)) {
    return configure("credentials", "需要选择地区", "请选择与 API Key 对应的 SiliconFlow 地区。", "region")
  }
  if (["litellm", "siliconflow"].includes(providerId ?? "") && /Add .*API key|API key is (?:invalid|expired)/i.test(message)) {
    return configure("credentials", "API Key 不可用", "请检查当前地区或代理对应的 API Key 及访问权限。", "apiKey")
  }

  if (providerId === "kiro" && isKiroCliLoginError(message)) {
    return recovery("login", "需要 Kiro CLI 登录", "请在终端运行 `kiro-cli login`，完成后检查连接。")
  }

  if (providerId === "codex" && message.includes("Windows requires Codex file storage:") && message.includes("cli_auth_credentials_store")) {
    return recovery("login", "需要文件登录凭据", '请在 Codex 的 `config.toml` 中设置 `cli_auth_credentials_store = "file"`，再运行 `codex login`，然后重试。')
  }
  if (/Claude Keychain credentials must be refreshed by Claude Code/i.test(message)) {
    return recovery("login", "需要更新登录", loginAdvice("claude"))
  }
  if (/credentials could not be read/i.test(message)) {
    return recovery("credentials", "无法读取登录凭据", "请检查服务商的本地登录文件和读取权限，然后重试。")
  }
  if (/no .*(?:api key|cookie|credentials?)(?: found| for |[.!])|(?:api key|credentials?) (?:not found|missing)|cookie missing|needs.*cookie header|no .*AK\/SK found|missing (?:api key|credentials?)|missing or invalid .*team id/i.test(message)) {
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
  if (/(?:session|token|login) expired|key was rejected|api key invalid|credentials are invalid|invalid (?:auth file|credentials?)|\bHTTP\s*401\b|\bunauthorized\b/i.test(message)) {
    return recovery("login", /(?:session|token) expired/i.test(message) ? "登录已过期" : "登录凭据失效", capabilities?.config?.fields.some((field) => field.type === "secret") ? "请更新当前连接凭据。" : loginAdvice(providerId))
  }
  if (/no .*subscription on this key/i.test(message)) {
    return recovery("permission", "账号订阅不可用", "请在服务商应用检查当前账号和订阅，再重试。")
  }
  if (/\bHTTP\s*403\b|permission denied|access (?:was )?denied|\bforbidden\b/i.test(message)) {
    return recovery("permission", "访问被拒绝", "请检查账号权限和凭据读取权限，然后重试。")
  }
  if (/\bHTTP\s*429\b|too many requests|is limiting requests|rate limit(?:ed| exceeded)|限制请求/i.test(message)) {
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
