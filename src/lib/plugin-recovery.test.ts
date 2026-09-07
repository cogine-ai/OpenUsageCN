import { describe, expect, it } from "vitest"
import { getPluginRecovery } from "@/lib/plugin-recovery"

describe("getPluginRecovery", () => {
  it.each([
    ["No Z.ai API key found. Add it in Settings or set ZAI_API_KEY/GLM_API_KEY.", "credentials"],
    ["Not logged in. Run `codex` to authenticate.", "login"],
    ["Session expired. Run `claude` to log in again.", "login"],
    ["OpenCode Go key was rejected. Log in with OpenCode Go again.", "login"],
    ["OpenCode Go not detected. Log in with OpenCode Go first.", "login"],
    ["OpenCode Go credentials are invalid. Log in with OpenCode Go again.", "login"],
    ["OpenCode Go credentials could not be read. Check OpenCode's local files and try again.", "credentials"],
    ["Usage request failed (HTTP 401).", "login"],
    ["OpenCode Go access was denied (HTTP 403). Check your key and account permissions.", "permission"],
    ["No OpenCode Go subscription on this key. Check your subscription in OpenCode.", "permission"],
    ["Usage request failed. Check your connection.", "network"],
    ["Request timed out", "network"],
    ["Usage request failed (HTTP 429). Try again later.", "rate_limit"],
    ["OpenCode Go is limiting requests. Try again later.", "rate_limit"],
    ["Usage response invalid. Try again later.", "invalid_response"],
    ["OpenCode response missing subscription usage fields.", "invalid_response"],
    ["Quota data is incomplete or invalid. Try again later.", "invalid_response"],
  ])("classifies the known provider failure: %s", (message, kind) => {
    const recovery = getPluginRecovery(message)
    expect(recovery.kind).toBe(kind)
    expect(recovery.advice).toMatch(/[\u4e00-\u9fff]/)
    expect(recovery.diagnostic).toBe(message)
  })

  it.each([
    "Rate limits unavailable. Try again later.",
    "Usage data unavailable. Try again later.",
    "Something unexpected: 429 items were examined",
    "Selected Claude account connection is unavailable.",
  ])("does not guess a cause for an ambiguous error: %s", (message) => {
    const recovery = getPluginRecovery(message)
    expect(recovery.kind).toBe("unknown")
    expect(recovery.advice).toContain("原因尚未识别")
    expect(recovery.diagnostic).toBe(message)
  })

  it("keeps the Windows Codex file-storage repair explicit", () => {
    const message = 'Not logged in with readable file credentials. Windows requires Codex file storage: set `cli_auth_credentials_store = "file"` in your Codex `config.toml`, then run `codex login`.'
    const recovery = getPluginRecovery(message, "codex")
    expect(recovery.kind).toBe("login")
    expect(recovery.advice).toContain('`cli_auth_credentials_store = "file"`')
    expect(recovery.advice).toContain("`codex login`")
    expect(recovery.diagnostic).toBe(message)
  })

  it("directs Keychain credential renewal to Claude Code", () => {
    const recovery = getPluginRecovery(
      "Claude Keychain credentials must be refreshed by Claude Code. Run `claude` and try again.",
      "claude",
    )
    expect(recovery.kind).toBe("login")
    expect(recovery.advice).toContain("Claude Code")
    expect(recovery.advice).toContain("登录")
  })

  it("keeps useful diagnostics while masking credential values and URL secrets", () => {
    const recovery = getPluginRecovery([
      "Request failed (HTTP 403)",
      'Authorization: Bearer auth-secret',
      'Cookie: session=cookie-secret; account=private',
      '{"key":"json-secret","access_token":"access-secret","refresh":"refresh-secret"}',
      'password = "password-secret"',
      'GET https://user:pass@example.com/usage?token=query-secret#fragment-secret',
      'Raw key sk-raw-secret',
    ].join("\n"))

    expect(recovery.diagnostic).toContain("HTTP 403")
    expect(recovery.diagnostic).toContain("https://example.com/usage")
    expect(recovery.diagnostic).toContain("[已隐藏]")
    for (const secret of ["auth-secret", "cookie-secret", "json-secret", "access-secret", "refresh-secret", "password-secret", "query-secret", "fragment-secret", "user:pass", "sk-raw-secret"]) {
      expect(recovery.diagnostic).not.toContain(secret)
    }
  })

  it("masks the complete escaped credential string without hiding configuration advice", () => {
    const diagnostic = getPluginRecovery(JSON.stringify({
      key: 'prefix"suffix-private',
      cli_auth_credentials_store: "file",
    })).diagnostic
    expect(diagnostic).not.toContain("prefix")
    expect(diagnostic).not.toContain("suffix-private")
    expect(diagnostic).toContain('"cli_auth_credentials_store":"file"')
  })

  it("masks Basic authentication and bare token fields", () => {
    const diagnostic = getPluginRecovery('Authorization: Basic basic-secret\ntoken=token-secret').diagnostic
    expect(diagnostic).not.toContain("basic-secret")
    expect(diagnostic).not.toContain("token-secret")
  })
})
