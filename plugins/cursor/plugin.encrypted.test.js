import "./unified-usage.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const jwt = (sub, exp = 9999999999) => `a.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.c`
const envelope = (id) => `cursor-safe-storage:v1:synthetic-${id}`

async function setup() {
  const ctx = makeCtx()
  const tokens = { access: jwt("auth0|encrypted-user", 1), refresh: jwt("auth0|encrypted-user") }
  const raw = { access: envelope("access"), refresh: envelope("refresh") }
  ctx.host.cursor = { decryptToken: vi.fn((value) => {
    if (value === raw.access) return tokens.access
    if (value === raw.refresh) return tokens.refresh
    throw new Error("Cursor credential could not be decrypted.")
  }) }
  ctx.host.sqlite.query.mockImplementation((_db, sql) => {
    if (sql.includes("accessToken")) return JSON.stringify([{ value: raw.access }])
    if (sql.includes("refreshToken")) return JSON.stringify([{ value: raw.refresh }])
    return "[]"
  })
  ctx.host.http.request.mockImplementation((request) => {
    if (request.url.includes("/oauth/token")) return { status: 200, bodyText: JSON.stringify({ access_token: jwt("auth0|encrypted-user") }) }
    if (request.url.endsWith("/api/auth/me")) return { status: 200, bodyText: JSON.stringify({ sub: "auth0|encrypted-user" }) }
    return { status: 200, bodyText: JSON.stringify({ enabled: true, planUsage: { totalSpend: 10, limit: 100 } }) }
  })
  await import("./plugin.js")
  return { ctx, plugin: globalThis.__openusage_plugin, raw, tokens }
}

describe("Cursor encrypted Desktop credentials", () => {
  beforeEach(() => { delete globalThis.__openusage_plugin; vi.resetModules() })

  it("discovers the decrypted complete identity", async () => {
    const { ctx, plugin } = await setup()
    expect(plugin.discoverConnections(ctx).observations[0]).toMatchObject({ normalizedIdentity: "auth0|encrypted-user", connectionKey: "cursor-desktop" })
  })

  it("binds generation to stored ciphertext, not decrypted values", async () => {
    const { ctx, plugin, raw } = await setup()
    const target = { connectionKey: "cursor-desktop" }
    const generation = plugin.credentialGeneration(ctx, target)
    raw.access = envelope("different-ciphertext")
    // Changing ciphertext remains visible even if it decrypts to the same token.
    expect(plugin.credentialGeneration(ctx, target)).not.toBe(generation)
  })

  it("calculates Desktop generation without decryption or Keychain access even when decryption is denied", async () => {
    const { ctx, plugin, raw } = await setup()
    ctx.host.cursor.decryptToken.mockImplementation(() => { throw new Error("denied: Cursor credential access") })
    const target = { connectionKey: "cursor-desktop" }
    const generation = plugin.credentialGeneration(ctx, target)
    const framed = "cursor-credential-v1\n" +
      raw.access.length + ":" + raw.access + raw.refresh.length + ":" + raw.refresh
    expect(generation).toBe(ctx.host.crypto.sha256Hex(framed))
    raw.refresh = envelope("changed-refresh")
    expect(plugin.credentialGeneration(ctx, target)).not.toBe(generation)
    expect(ctx.host.cursor.decryptToken).not.toHaveBeenCalled()
    expect(ctx.host.keychain.readGenericPassword).not.toHaveBeenCalled()
    expect(ctx.host.keychain.readGenericPasswordForCurrentUser).not.toHaveBeenCalled()
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("rejects a newer lease when storage rotates after the credential snapshot was captured", async () => {
    const { ctx, plugin, raw, tokens } = await setup()
    const captured = { ...raw }
    const newer = { access: envelope("new-access"), refresh: envelope("new-refresh") }
    const framed = "cursor-credential-v1\n" +
      newer.access.length + ":" + newer.access + newer.refresh.length + ":" + newer.refresh
    const generation = ctx.host.crypto.sha256Hex(framed)
    ctx.host.cursor.decryptToken.mockImplementation((value) => {
      Object.assign(raw, newer)
      if (value === captured.access) return tokens.access
      if (value === captured.refresh) return tokens.refresh
      throw new Error("unexpected credential")
    })
    expect(() => plugin.probe(ctx, {
      connectionKey: "cursor-desktop", credentialGeneration: generation,
    })).toThrow("Account credentials changed during refresh")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })

  it("rejects scoped refresh when ciphertext rotates during the OAuth request", async () => {
    const { ctx, plugin, raw } = await setup()
    const target = { connectionKey: "cursor-desktop" }
    const generation = plugin.credentialGeneration(ctx, target)
    const base = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => {
      if (request.url.includes("/oauth/token")) raw.access = envelope("rotated")
      return base(request)
    })
    expect(() => plugin.probe(ctx, { ...target, credentialGeneration: generation }))
      .toThrow("Account credentials changed during refresh")
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })

  it("keeps an encrypted source read-only even when the stored format changes during refresh", async () => {
    const { ctx, plugin, raw } = await setup()
    const base = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => {
      if (request.url.includes("/oauth/token")) {
        raw.access = jwt("auth0|new-desktop-user")
        raw.refresh = jwt("auth0|new-desktop-user")
      }
      return base(request)
    })
    plugin.probe(ctx)
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("does not overwrite ciphertext when a plain source migrates during an unscoped refresh", async () => {
    const { ctx, plugin, raw, tokens } = await setup()
    raw.access = tokens.access
    raw.refresh = tokens.refresh
    const captured = { ...raw }
    const migrated = { access: envelope("migrated-access"), refresh: envelope("migrated-refresh") }
    const base = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => {
      if (request.url.includes("/oauth/token")) Object.assign(raw, migrated)
      return base(request)
    })
    // Model SQLite's CHECK guard: the transaction must abort before its INSERT
    // when stored credentials no longer match the captured plain values.
    ctx.host.sqlite.exec.mockImplementation((_db, sql) => {
      if (sql.startsWith("BEGIN IMMEDIATE;") &&
          sql.includes("value = '" + captured.access + "'") &&
          sql.includes("value = '" + captured.refresh + "'")) {
        throw new Error("CHECK constraint failed")
      }
      raw.access = "unguarded-plaintext-overwrite"
    })
    plugin.probe(ctx)
    expect(ctx.host.sqlite.exec).toHaveBeenCalledTimes(1)
    expect(raw).toEqual(migrated)
    expect(ctx.host.log.warn.mock.calls.some(([message]) =>
      message.includes("Account credentials changed during refresh"))).toBe(true)
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it.each([false, true])("refreshes without overwriting encrypted storage (scoped=%s)", async (scoped) => {
    const { ctx, plugin, raw } = await setup()
    const original = { ...raw }
    const target = { connectionKey: "cursor-desktop" }
    const output = plugin.probe(ctx, scoped ? { ...target, credentialGeneration: plugin.credentialGeneration(ctx, target) } : undefined)
    expect(output.lines.some((line) => line.label === "Total usage")).toBe(true)
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
    expect(raw).toEqual(original)
  })

  it("keeps history refresh in memory", async () => {
    const { ctx, plugin } = await setup()
    const target = { connectionKey: "cursor-desktop" }
    expect(plugin.historyCredential(ctx, { ...target, credentialGeneration: plugin.credentialGeneration(ctx, target) }).cookieHeader).toContain("WorkosCursorSessionToken=")
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })

  it("reports decryption denial instead of silently choosing another account", async () => {
    const { ctx, plugin } = await setup()
    ctx.host.cursor.decryptToken.mockImplementation(() => { throw new Error("denied: Cursor credential access") })
    expect(() => plugin.discoverConnections(ctx)).toThrow("denied:")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("rejects an identity changed by token refresh without writing", async () => {
    const { ctx, plugin } = await setup()
    const base = ctx.host.http.request.getMockImplementation()
    ctx.host.http.request.mockImplementation((request) => request.url.endsWith("/api/auth/me")
      ? { status: 200, bodyText: JSON.stringify({ sub: "auth0|different-user" }) } : base(request))
    const target = { connectionKey: "cursor-desktop" }
    expect(() => plugin.probe(ctx, { ...target, credentialGeneration: plugin.credentialGeneration(ctx, target) })).toThrow()
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })
})
