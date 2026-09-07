import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

describe("Codex Windows File Credentials", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  async function load() {
    await import("./plugin.js")
    return globalThis.__openusage_plugin
  }

  it.each([null, "{invalid", JSON.stringify({ tokens: {} })])(
    "explains file storage when credentials are missing or unreadable: %s",
    async (contents) => {
      const ctx = makeCtx()
      ctx.app.platform = "windows"
      if (contents !== null) ctx.host.fs.writeText("~/.codex/auth.json", contents)
      const plugin = await load()
      expect(() => plugin.probe(ctx)).toThrow('cli_auth_credentials_store = "file"')
      expect(() => plugin.probe(ctx)).toThrow("codex login")
      expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
      expect(ctx.host.http.request).not.toHaveBeenCalled()
      expect(ctx.host.log.error).toHaveBeenCalled()
    },
  )

  it.each(["C:\\Users\\Test User\\Codex Home", "C:\\Users\\Test User\\Codex Home\\", "C:/Users/Test User/Codex Home/"])(
    "keeps a custom Windows path authoritative: %s",
    async (home) => {
      const ctx = makeCtx()
      ctx.app.platform = "windows"
      ctx.host.env.get.mockImplementation((key) => key === "CODEX_HOME" ? home : null)
      const authPath = home.replace(/[\\/]+$/, "") + "/auth.json"
      const auth = (token) => JSON.stringify({ tokens: { access_token: token }, last_refresh: new Date().toISOString() })
      ctx.host.fs.writeText(authPath, auth("custom-home-token"))
      ctx.host.fs.writeText("~/.codex/auth.json", auth("other-account-token"))
      ctx.host.http.request.mockImplementation((request) => {
        expect(request.headers.Authorization).toBe("Bearer custom-home-token")
        return { status: 200, headers: {}, bodyText: JSON.stringify({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } }) }
      })
      const plugin = await load()
      const result = plugin.probe(ctx)
      expect(result.lines.find((line) => line.label === "5小时")?.used).toBe(12)
      expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
      expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
    },
  )

  it("does not read another account when custom Windows home is missing", async () => {
    const ctx = makeCtx()
    ctx.app.platform = "windows"
    ctx.host.env.get.mockImplementation((key) => key === "CODEX_HOME" ? "C:\\Users\\Test User\\Missing" : null)
    ctx.host.fs.writeText("~/.codex/auth.json", JSON.stringify({ tokens: { access_token: "other-account-token" } }))
    const plugin = await load()
    expect(() => plugin.probe(ctx)).toThrow('cli_auth_credentials_store = "file"')
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
  })
})
