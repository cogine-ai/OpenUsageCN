import { describe, expect, it } from "vitest"
import { makeCtx } from "./test-helpers.js"

describe("test helper normalizeHttpsBaseUrl", () => {
  it("normalizes unambiguous HTTPS base URLs", () => {
    const ctx = makeCtx()
    expect(
      ctx.host.http.normalizeHttpsBaseUrl(" https://Gateway.Example:8443/openrouter/v1/// ")
    ).toBe("https://gateway.example:8443/openrouter/v1")
    expect(ctx.host.http.normalizeHttpsBaseUrl("HTTPS://gateway.example/api/v1/")).toBe(
      "https://gateway.example/api/v1"
    )
  })

  it("rejects ambiguous URLs before plugins send API keys", () => {
    const ctx = makeCtx()
    const invalid = [
      "https://openrouter.ai@attacker.example/api/v1",
      "https:///api/v1",
      "https://openrouter.ai/api/v1?route=credits",
      "https://openrouter.ai/api/v1?",
      "https://openrouter.ai/api/v1#",
      "https://openrouter.ai\\@attacker.example/api/v1",
      "https://openrouter.ai/api/\u0085v1",
      "http://openrouter.ai/api/v1",
      "https://user:password@example.com/api/v1",
    ]

    for (const apiUrl of invalid) {
      expect(ctx.host.http.normalizeHttpsBaseUrl(apiUrl)).toBeNull()
    }
  })
})
