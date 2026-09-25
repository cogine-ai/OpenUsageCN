import { beforeEach, describe, expect, it } from "vitest"
import { makeCtx } from "../test-helpers.js"

const SETTINGS_URL = "https://ollama.com/settings"
const COOKIE = "__Secure-session=test-session; other=hello"

async function loadPlugin() {
  await import("./plugin.js?test=" + Math.random())
  return globalThis.__openusage_plugin
}

function withCookie(ctx, cookie = COOKIE) {
  ctx.host.config.get.mockReturnValue(cookie)
}

function respond(ctx, html, status = 200) {
  ctx.host.http.request.mockReturnValue({ status, bodyText: html })
}

describe("Ollama Cloud plugin", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin })

  it("requires a signed-in browser session rather than local Ollama installation", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText("~/.ollama/id_ed25519", "local-key")
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("needs a signed-in browser Cookie header")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("rejects a Cookie header without an Ollama session", async () => {
    const ctx = makeCtx()
    withCookie(ctx, "theme=dark")
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Cookie header is invalid")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("rejects an empty Ollama session cookie", async () => {
    const ctx = makeCtx()
    withCookie(ctx, "__Secure-session=; theme=dark")
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Cookie header is invalid")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("reads monthly credits and reset from CodexBar's captured settings markup", async () => {
    const ctx = makeCtx()
    withCookie(ctx, "Cookie: " + COOKIE)
    // From CodexBar OllamaUsageParserTests.swift:209-269 (captured monthly-credit markup).
    respond(ctx, `
      <h2><span>Included usage</span><span class="text-xs">pro</span\n></h2>
      <div><span class="text-sm">Monthly usage</span>
        <span class="text-sm ">$7.50 of $60 used</span\n>
        <div aria-label="Monthly usage $7.50 of $60 used"
          style="width: 12.5%; "></div>
        <div class="local-time" data-time="2026-09-30T15:14:29Z">Resets in 4 weeks.</div>
      </div>`)
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines).toEqual([{
      type: "progress", label: "Monthly", used: 12.5, limit: 100,
      format: { kind: "percent" }, resetsAt: "2026-09-30T15:14:29.000Z",
    }])
    expect(ctx.host.http.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET", url: SETTINGS_URL,
      headers: expect.objectContaining({ Cookie: COOKIE, Accept: expect.stringContaining("text/html") }),
    }))
  })

  it("keeps legacy session and weekly usage from CodexBar's settings fixture", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    // From CodexBar OllamaUsageParserTests.swift:5-48.
    respond(ctx, `<div>
      <span>Session usage</span><span>0.1% used</span>
      <div class="local-time" data-time="2026-01-30T18:00:00Z">Resets in 3 hours</div>
      <span>Weekly usage</span><span>0.7% used</span>
      <div class="local-time" data-time="2026-02-02T00:00:00Z">Resets in 2 days</div>
    </div>`)
    const plugin = await loadPlugin()
    const lines = plugin.probe(ctx).lines

    expect(lines.map((line) => [line.label, line.used])).toEqual([
      ["Session", 0.1], ["Weekly", 0.7],
    ])
    expect(lines[1].resetsAt).toBe("2026-02-02T00:00:00.000Z")
  })

  it("uses the environment Cookie when Settings has no value", async () => {
    const ctx = makeCtx()
    ctx.host.env.get.mockReturnValue(COOKIE)
    respond(ctx, "<span>Monthly usage</span><span>0% used</span>")
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines[0].used).toBe(0)
    expect(ctx.host.env.get).toHaveBeenCalledWith("OLLAMA_CLOUD_COOKIE")
  })

  it("surfaces expired sessions and never logs their Cookie value", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    respond(ctx, "", 302)
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("session expired")
    const logged = ctx.host.log.warn.mock.calls.flat().join(" ")
    expect(logged).not.toContain("test-session")
  })

  it("recognizes a signed-out settings page", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    respond(ctx, `<h1>Sign in to Ollama</h1><form action="/auth/signin">
      <input type="email" name="email"><input type="password" name="password">
    </form>`)
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("session expired")
  })

  it("uses the meter width when the monthly dollar limit is zero", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    respond(ctx, `<span>Monthly usage</span><span>$0 of $0 used</span><div style="width: 25%;"></div>`)
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines[0].used).toBe(25)
  })

  it("does not borrow the next window's meter for an invalid monthly amount", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    respond(ctx, `<span>Monthly usage</span><span>$1,25 of $60 used</span>
      <span>Weekly usage</span><div style="width: 42%;"></div>`)
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines.map((line) => [line.label, line.used])).toEqual([["Weekly", 42]])
  })

  it("fails loudly if Ollama changes its settings page", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    respond(ctx, "<html><body>No usage here. login status unknown.</body></html>")
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("no supported usage windows")
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("logs network failures while showing a friendly error", async () => {
    const ctx = makeCtx()
    withCookie(ctx)
    ctx.host.http.request.mockImplementation(() => { throw new Error("socket closed") })
    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Could not reach Ollama Cloud")
    expect(ctx.host.log.error).toHaveBeenCalledWith("Ollama Cloud usage network request failed")
  })
})
