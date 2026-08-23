import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function makeJwt(payload) {
  const jwtPayload = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/=+$/g, "")
  return `a.${jwtPayload}.c`
}

describe("cursor plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when no token", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([]))
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("discovers matching Desktop and CLI sessions as independent connections", async () => {
    const ctx = makeCtx()
    const sharedToken = makeJwt({ sub: "auth0|shared-user", exp: 9999999999 })
    ctx.host.sqlite.query.mockImplementation((_db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: sharedToken }])
      }
      return JSON.stringify([])
    })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return sharedToken
      return null
    })
    const plugin = await loadPlugin()

    const report = plugin.discoverConnections(ctx)

    expect(report).toEqual({
      observations: [
        {
          identityNamespace: "cursor-sub-v1",
          normalizedIdentity: "auth0|shared-user",
          connectionKey: "cursor-desktop",
          connectionKind: "desktop",
        },
        {
          identityNamespace: "cursor-sub-v1",
          normalizedIdentity: "auth0|shared-user",
          connectionKey: "cursor-cli",
          connectionKind: "cli",
        },
      ],
      sourceOutcomes: [
        { sourceKey: "cursor-desktop", status: "available" },
        { sourceKey: "cursor-cli", status: "available" },
      ],
      defaultConnectionKey: "cursor-desktop",
    })
  })

  it("keeps different Desktop and CLI identities and preserves the existing Auto preference", async () => {
    const ctx = makeCtx()
    const desktopToken = makeJwt({ sub: "auth0|desktop-user", exp: 9999999999 })
    const cliToken = makeJwt({ sub: "auth0|cli-user", exp: 9999999999 })
    ctx.host.sqlite.query.mockImplementation((_db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: desktopToken }])
      }
      if (String(sql).includes("cursorAuth/stripeMembershipType")) {
        return JSON.stringify([{ value: " Free " }])
      }
      return JSON.stringify([])
    })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return cliToken
      return null
    })
    const plugin = await loadPlugin()

    const report = plugin.discoverConnections(ctx)

    expect(report.observations.map((item) => item.normalizedIdentity)).toEqual([
      "auth0|desktop-user",
      "auth0|cli-user",
    ])
    expect(report.defaultConnectionKey).toBe("cursor-cli")
  })

  it("marks a credential without a full JWT subject unavailable without inventing identity", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockImplementation((_db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: "opaque-token" }])
      }
      return JSON.stringify([])
    })
    const plugin = await loadPlugin()

    const report = plugin.discoverConnections(ctx)

    expect(report.observations).toEqual([])
    expect(report.sourceOutcomes).toEqual([
      { sourceKey: "cursor-desktop", status: "unavailable" },
      { sourceKey: "cursor-cli", status: "absent" },
    ])
    expect(report.defaultConnectionKey).toBeNull()
  })

  it("derives a credential generation from the exact selected source state", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|cli-user", exp: 9999999999 })
    let refreshToken = "refresh-a"
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return refreshToken
      return null
    })
    const plugin = await loadPlugin()

    const first = plugin.credentialGeneration(ctx, { connectionKey: "cursor-cli" })
    refreshToken = "refresh-b"
    const second = plugin.credentialGeneration(ctx, { connectionKey: "cursor-cli" })

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toMatch(/^[a-f0-9]{64}$/)
    expect(second).not.toBe(first)
  })

  it("derives a history cookie only from the generation-bound local connection", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|local-user", exp: 9999999999 })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    expect(
      plugin.historyCredential(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toEqual({
      cookieHeader: `WorkosCursorSessionToken=local-user%3A%3A${accessToken}`,
    })
  })

  it("refreshes an expired history session in memory without mutating the selected source", async () => {
    const ctx = makeCtx()
    const expiredAccessToken = makeJwt({ sub: "auth0|local-user", exp: 1 })
    const refreshedAccessToken = makeJwt({ sub: "auth0|local-user", exp: 9999999999 })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return expiredAccessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ access_token: refreshedAccessToken }),
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    expect(
      plugin.historyCredential(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toEqual({
      cookieHeader: `WorkosCursorSessionToken=local-user%3A%3A${refreshedAccessToken}`,
    })
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("rejects history credential extraction after the local generation changes", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|local-user", exp: 9999999999 })
    let refreshToken = "refresh-a"
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return refreshToken
      return null
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })
    refreshToken = "refresh-b"

    expect(() =>
      plugin.historyCredential(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toThrow("Account credentials changed")
  })

  it("rejects a scoped probe when its credential generation is no longer current", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|cli-user", exp: 9999999999 })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    const plugin = await loadPlugin()

    expect(() =>
      plugin.probe(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration: "0".repeat(64),
      })
    ).toThrow("Account credentials changed")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("rejects a scoped local session whose auth identity only shares the JWT subject suffix", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|shared-tail", exp: 9999999999 })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    let authRequest = null
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url) === "https://cursor.com/api/auth/me") {
        authRequest = opts
        return {
          status: 200,
          bodyText: JSON.stringify({ sub: "google-oauth2|shared-tail" }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    expect(() =>
      plugin.probe(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toThrow("Selected Cursor account identity could not be verified")
    expect(authRequest).toMatchObject({
      method: "GET",
      url: "https://cursor.com/api/auth/me",
      headers: {
        Accept: "application/json",
        Cookie: `WorkosCursorSessionToken=shared-tail%3A%3A${accessToken}`,
      },
      timeoutMs: 10000,
    })
    expect(
      ctx.host.http.request.mock.calls.filter(([opts]) =>
        String(opts.url).includes("GetCurrentPeriodUsage")
      )
    ).toHaveLength(0)
  })

  it.each([
    ["401", { status: 401, bodyText: "identity-response-secret" }],
    ["403", { status: 403, bodyText: "identity-response-secret" }],
    ["redirect", { status: 302, bodyText: "identity-response-secret" }],
    ["malformed body", { status: 200, bodyText: "identity-response-secret" }],
    ["missing subject", { status: 200, bodyText: "{}" }],
    ["mismatched subject", { status: 200, bodyText: JSON.stringify({ sub: "auth0|other" }) }],
  ])("fails a scoped local probe on auth identity %s before usage", async (_caseName, authResponse) => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|selected", exp: 9999999999 })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url) === "https://cursor.com/api/auth/me") return authResponse
      throw new Error("usage must not be requested")
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    expect(() =>
      plugin.probe(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toThrow("Selected Cursor account identity could not be verified")
    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    const logged = [
      ...ctx.host.log.trace.mock.calls,
      ...ctx.host.log.debug.mock.calls,
      ...ctx.host.log.info.mock.calls,
      ...ctx.host.log.warn.mock.calls,
      ...ctx.host.log.error.mock.calls,
    ].flat().join(" ")
    expect(logged).not.toContain("auth0|selected")
    expect(logged).not.toContain("auth0|other")
    expect(logged).not.toContain("identity-response-secret")
  })

  it("keeps the non-account-scoped legacy probe free of auth identity requests", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|legacy", exp: 9999999999 })
    ctx.host.sqlite.query.mockImplementation((_db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: accessToken }])
      }
      return JSON.stringify([])
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url) === "https://cursor.com/api/auth/me") {
        throw new Error("legacy probe must not verify account identity")
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })
    const plugin = await loadPlugin()

    expect(plugin.probe(ctx).lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(
      ctx.host.http.request.mock.calls.some(([opts]) =>
        String(opts.url) === "https://cursor.com/api/auth/me"
      )
    ).toBe(false)
  })

  it("verifies the explicitly selected Desktop session before its usage request", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|desktop-user", exp: 9999999999 })
    ctx.host.sqlite.query.mockImplementation((_db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: accessToken }])
      }
      return JSON.stringify([])
    })
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url === "https://cursor.com/api/auth/me") {
        expect(opts.headers.Cookie).toBe(
          `WorkosCursorSessionToken=desktop-user%3A%3A${accessToken}`
        )
        return {
          status: 200,
          bodyText: JSON.stringify({ sub: "auth0|desktop-user" }),
        }
      }
      if (url.includes("GetCurrentPeriodUsage")) {
        expect(opts.headers.Authorization).toBe("Bearer " + accessToken)
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-desktop",
    })

    const result = plugin.probe(ctx, {
      connectionKey: "cursor-desktop",
      credentialGeneration,
    })

    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("writes a scoped refresh only through a generation-checked account source", async () => {
    const ctx = makeCtx()
    const expiredAccessToken = makeJwt({ sub: "auth0|cli-user", exp: 1 })
    const refreshedAccessToken = makeJwt({ sub: "auth0|cli-user", exp: 9999999999 })
    let currentAccessToken = expiredAccessToken
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return currentAccessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    ctx.host.keychain.writeGenericPassword.mockImplementation((service, value) => {
      if (service === "cursor-access-token") currentAccessToken = value
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: refreshedAccessToken }),
        }
      }
      if (String(opts.url) === "https://cursor.com/api/auth/me") {
        expect(opts.headers.Cookie).toBe(
          `WorkosCursorSessionToken=cli-user%3A%3A${refreshedAccessToken}`
        )
        return {
          status: 200,
          bodyText: JSON.stringify({ sub: "auth0|cli-user" }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    const result = plugin.probe(ctx, {
      connectionKey: "cursor-cli",
      credentialGeneration,
    })

    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(ctx.host.keychain.writeGenericPassword).toHaveBeenCalledWith(
      "cursor-access-token",
      refreshedAccessToken
    )
    expect(currentAccessToken).toBe(refreshedAccessToken)
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })

  it("rejects a scoped refresh write when the local login changes before CAS", async () => {
    const ctx = makeCtx()
    const expiredAccessToken = makeJwt({ sub: "auth0|selected", exp: 1 })
    const refreshedAccessToken = makeJwt({ sub: "auth0|selected", exp: 9999999999 })
    const switchedAccessToken = makeJwt({ sub: "auth0|other", exp: 9999999999 })
    let currentAccessToken = expiredAccessToken
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return currentAccessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("/oauth/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: refreshedAccessToken }),
        }
      }
      if (url === "https://cursor.com/api/auth/me") {
        currentAccessToken = switchedAccessToken
        return {
          status: 200,
          bodyText: JSON.stringify({ sub: "auth0|selected" }),
        }
      }
      throw new Error("usage must not be requested")
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    expect(() =>
      plugin.probe(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toThrow("Account credentials changed")
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled()
  })

  it("revalidates a scoped identity before retrying usage with a refreshed token", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "auth0|selected", exp: 9999999999 })
    const refreshedToken = makeJwt({ sub: "auth0|different", exp: 9999999999 })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return accessToken
      if (service === "cursor-refresh-token") return "refresh-current"
      return null
    })
    let authCalls = 0
    let usageCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url === "https://cursor.com/api/auth/me") {
        authCalls += 1
        return {
          status: 200,
          bodyText: JSON.stringify({
            sub: authCalls === 1 ? "auth0|selected" : "auth0|different",
          }),
        }
      }
      if (url.includes("GetCurrentPeriodUsage")) {
        usageCalls += 1
        if (usageCalls === 1) return { status: 401, bodyText: "" }
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      if (url.includes("/oauth/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: refreshedToken }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    const credentialGeneration = plugin.credentialGeneration(ctx, {
      connectionKey: "cursor-cli",
    })

    expect(() =>
      plugin.probe(ctx, {
        connectionKey: "cursor-cli",
        credentialGeneration,
      })
    ).toThrow("Selected Cursor account identity could not be verified")
    expect(authCalls).toBe(2)
    expect(usageCalls).toBe(1)
  })

  it("loads tokens from keychain when sqlite has none", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([]))
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return "keychain-access-token"
      if (service === "cursor-refresh-token") return "keychain-refresh-token"
      return null
    })
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        enabled: true,
        planUsage: { totalSpend: 1200, limit: 2400 },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(ctx.host.keychain.readGenericPassword).toHaveBeenCalledWith("cursor-access-token")
    expect(ctx.host.keychain.readGenericPassword).toHaveBeenCalledWith("cursor-refresh-token")
  })

  it("probes the explicitly selected CLI connection even when Desktop would be Auto", async () => {
    const ctx = makeCtx()
    const desktopToken = makeJwt({ sub: "auth0|desktop", exp: 9999999999 })
    const cliToken = makeJwt({ sub: "auth0|cli", exp: 9999999999 })
    ctx.host.sqlite.query.mockImplementation((_db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: desktopToken }])
      }
      return JSON.stringify([])
    })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return cliToken
      return null
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url) === "https://cursor.com/api/auth/me") {
        expect(opts.headers.Cookie).toBe(
          `WorkosCursorSessionToken=cli%3A%3A${cliToken}`
        )
        return {
          status: 200,
          bodyText: JSON.stringify({ sub: "auth0|cli" }),
        }
      }
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        expect(opts.headers.Authorization).toBe("Bearer " + cliToken)
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })
    const plugin = await loadPlugin()

    const result = plugin.probe(ctx, {
      connectionKey: "cursor-cli",
      credentialGeneration: plugin.credentialGeneration(ctx, {
        connectionKey: "cursor-cli",
      }),
    })

    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("refreshes keychain access token and persists to keychain source", async () => {
    const ctx = makeCtx()
    const expiredPayload = Buffer.from(JSON.stringify({ exp: 1 }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const expiredAccessToken = `a.${expiredPayload}.c`
    const freshPayload = Buffer.from(JSON.stringify({ exp: 9999999999 }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const refreshedAccessToken = `a.${freshPayload}.c`

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([]))
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return expiredAccessToken
      if (service === "cursor-refresh-token") return "keychain-refresh-token"
      return null
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: refreshedAccessToken }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(ctx.host.keychain.writeGenericPassword).toHaveBeenCalledWith(
      "cursor-access-token",
      refreshedAccessToken
    )
    expect(ctx.host.sqlite.exec).not.toHaveBeenCalled()
  })

  it("prefers sqlite tokens when sqlite and keychain both have tokens", async () => {
    const ctx = makeCtx()
    const sqlitePayload = Buffer.from(JSON.stringify({ exp: 9999999999 }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const sqliteToken = `a.${sqlitePayload}.c`
    const keychainPayload = Buffer.from(JSON.stringify({ exp: 9999999999, sub: "keychain" }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const keychainToken = `a.${keychainPayload}.c`

    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: sqliteToken }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) {
        return JSON.stringify([{ value: "sqlite-refresh-token" }])
      }
      return JSON.stringify([])
    })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return keychainToken
      if (service === "cursor-refresh-token") return "keychain-refresh-token"
      return null
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        expect(opts.headers.Authorization).toBe("Bearer " + sqliteToken)
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(ctx.host.keychain.readGenericPassword).toHaveBeenCalledWith("cursor-access-token")
    expect(ctx.host.keychain.readGenericPassword).toHaveBeenCalledWith("cursor-refresh-token")
  })

  it("prefers keychain when sqlite looks free and token subjects differ", async () => {
    const ctx = makeCtx()
    const sqlitePayload = Buffer.from(
      JSON.stringify({ exp: 9999999999, sub: "google-oauth2|sqlite-user" }),
      "utf8"
    )
      .toString("base64")
      .replace(/=+$/g, "")
    const sqliteToken = `a.${sqlitePayload}.c`

    const keychainPayload = Buffer.from(
      JSON.stringify({ exp: 9999999999, sub: "auth0|keychain-user" }),
      "utf8"
    )
      .toString("base64")
      .replace(/=+$/g, "")
    const keychainToken = `a.${keychainPayload}.c`

    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: sqliteToken }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) {
        return JSON.stringify([{ value: "sqlite-refresh-token" }])
      }
      if (String(sql).includes("cursorAuth/stripeMembershipType")) {
        return JSON.stringify([{ value: "free" }])
      }
      return JSON.stringify([])
    })
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "cursor-access-token") return keychainToken
      if (service === "cursor-refresh-token") return "keychain-refresh-token"
      return null
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        expect(opts.headers.Authorization).toBe("Bearer " + keychainToken)
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          enabled: true,
          planUsage: { totalSpend: 1200, limit: 2400 },
        }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("throws on sqlite errors when reading token", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockImplementation(() => {
      throw new Error("boom")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
    expect(ctx.host.log.warn).toHaveBeenCalled()
  })

  it("throws on disabled usage", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ enabled: false }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No active Cursor subscription.")
  })

  it("throws on missing plan usage data", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ enabled: true }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No active Cursor subscription.")
  })

  it("accepts team usage when enabled flag is missing", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770064133000",
            billingCycleEnd: "1772483333000",
            planUsage: { totalSpend: 8474, limit: 2000, bonusSpend: 6474 },
            spendLimitUsage: {
              pooledLimit: 60000,
              pooledRemaining: 19216,
            },
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ planInfo: { planName: "Team" } }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Team")
    const totalLine = result.lines.find((line) => line.label === "Total usage")
    expect(totalLine).toBeTruthy()
    expect(totalLine.format).toEqual({ kind: "dollars" })
    expect(totalLine.used).toBe(84.74)
    expect(totalLine.limit).toBe(20)
    expect(result.lines.find((line) => line.label === "Bonus spend")).toBeTruthy()
  })

  it("throws on missing total usage limit", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        enabled: true,
        planUsage: { totalSpend: 1200 }, // missing limit
      }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Total usage limit missing")
  })

  it("uses percent-only usage when totalPercentUsed exists but limit is missing", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            billingCycleStart: "1772556293029",
            billingCycleEnd: "1775234693029",
            planUsage: {
              autoPercentUsed: 0,
              apiPercentUsed: 0,
              totalPercentUsed: 0,
            },
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Free" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        throw new Error("unexpected REST usage fallback")
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Free")
    const totalLine = result.lines.find((line) => line.label === "Total usage")
    expect(totalLine).toBeTruthy()
    expect(totalLine.format).toEqual({ kind: "percent" })
    expect(totalLine.used).toBe(0)
    expect(totalLine.limit).toBe(100)
  })

  it("uses percent-only free usage when pooledLimit is zero", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            billingCycleStart: "1772556293029",
            billingCycleEnd: "1775234693029",
            planUsage: {
              autoPercentUsed: 0,
              apiPercentUsed: 0,
              totalPercentUsed: 0,
            },
            spendLimitUsage: { pooledLimit: 0, pooledRemaining: 0 },
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Free" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        throw new Error("unexpected REST usage fallback")
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Free")
    const totalLine = result.lines.find((line) => line.label === "Total usage")
    expect(totalLine).toBeTruthy()
    expect(totalLine.format).toEqual({ kind: "percent" })
    expect(totalLine.used).toBe(0)
    expect(totalLine.limit).toBe(100)
  })

  it("renders percent-only usage when plan info is unavailable", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            billingCycleStart: "1772556293029",
            billingCycleEnd: "1775234693029",
            planUsage: {
              totalPercentUsed: 42,
            },
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return { status: 503, bodyText: "" }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        throw new Error("unexpected REST usage fallback")
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeNull()
    const totalLine = result.lines.find((line) => line.label === "Total usage")
    expect(totalLine).toBeTruthy()
    expect(totalLine.format).toEqual({ kind: "percent" })
    expect(totalLine.used).toBe(42)
    expect(totalLine.limit).toBe(100)
  })

  it("falls back to computed percent when totalSpend missing and no totalPercentUsed", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        enabled: true,
        planUsage: { limit: 2400, remaining: 1200 },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const planLine = result.lines.find((l) => l.label === "Total usage")
    expect(planLine).toBeTruthy()
    expect(planLine.format).toEqual({ kind: "percent" })
    // computed = (2400 - 1200) / 2400 * 100 = 50
    expect(planLine.used).toBe(50)
  })

  it("renders usage + plan info", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400, bonusSpend: 100 },
            spendLimitUsage: { individualLimit: 5000, individualRemaining: 1000 },
            billingCycleEnd: Date.now(),
          }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ planInfo: { planName: "pro plan" } }),
      }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("maps a mixed-case pro_plus plan with surrounding whitespace to Pro+", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ planInfo: { planName: "  PrO_PlUs  " } }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Pro+")
  })

  it("omits plan badge for blank plan names", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ planInfo: { planName: "   " } }),
      }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeFalsy()
  })

  it("uses pooled spend limits when individual values missing", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
            spendLimitUsage: { pooledLimit: 2000, pooledRemaining: 500 },
          }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ planInfo: { planName: "pro plan" } }),
      }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "On-demand")).toBeTruthy()
  })

  it("throws on token expired", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({ status: 401, bodyText: "" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token expired")
  })

  it("throws on http errors", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({ status: 500, bodyText: "" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("HTTP 500")
  })

  it("throws on usage request errors", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("boom")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed")
  })

  it("throws on parse errors", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: "not-json",
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage response invalid")
  })

  it("handles enterprise account with request-based usage", async () => {
    const ctx = makeCtx()

    // Build a JWT with a sub claim containing a user ID
    const jwtPayload = Buffer.from(
      JSON.stringify({ sub: "google-oauth2|user_abc123", exp: 9999999999 }),
      "utf8"
    )
      .toString("base64")
      .replace(/=+$/g, "")
    const accessToken = `a.${jwtPayload}.c`

    ctx.host.sqlite.query.mockReturnValue(
      JSON.stringify([{ value: accessToken }])
    )
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        // Enterprise returns no enabled/planUsage
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
            displayThreshold: 100,
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise", price: "Custom" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 422,
              numRequestsTotal: 422,
              numTokens: 171664819,
              maxRequestUsage: 500,
              maxTokenUsage: null,
            },
            startOfMonth: "2026-02-01T06:12:57.000Z",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Enterprise")
    const reqLine = result.lines.find((l) => l.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(422)
    expect(reqLine.limit).toBe(500)
    expect(reqLine.format).toEqual({ kind: "count", suffix: "requests" })
  })

  it("falls back to enterprise request-based usage when planUsage.limit is missing", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
            planUsage: {
              totalSpend: 1234,
              totalPercentUsed: 12,
            },
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 211,
              maxRequestUsage: 500,
            },
            startOfMonth: "2026-02-01T06:12:57.000Z",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Enterprise")
    const reqLine = result.lines.find((line) => line.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(211)
    expect(reqLine.limit).toBe(500)
  })

  it("falls back to REST usage for team-inferred account with percent-only and unavailable plan info", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            billingCycleStart: "1772556293029",
            billingCycleEnd: "1775234693029",
            planUsage: {
              totalPercentUsed: 35,
            },
            spendLimitUsage: {
              limitType: "team",
              pooledLimit: 5000,
            },
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return { status: 503, bodyText: "" }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 150,
              maxRequestUsage: 500,
            },
            startOfMonth: "2026-02-01T06:12:57.000Z",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const reqLine = result.lines.find((l) => l.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(150)
    expect(reqLine.limit).toBe(500)
    expect(reqLine.format).toEqual({ kind: "count", suffix: "requests" })
  })

  it("handles team account with request-based usage", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(
      JSON.stringify([{ value: accessToken }])
    )
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1772124774973",
            billingCycleEnd: "1772124774973",
            displayThreshold: 100,
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: {
              planName: "Team",
              includedAmountCents: 2000,
              price: "$40/mo",
              billingCycleEnd: "1773077797000",
            },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 39,
              numRequestsTotal: 39,
              numTokens: 12345,
              maxRequestUsage: 500,
              maxTokenUsage: null,
            },
            startOfMonth: "2026-02-09T17:36:37.000Z",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Team")
    const reqLine = result.lines.find((l) => l.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(39)
    expect(reqLine.limit).toBe(500)
    expect(reqLine.format).toEqual({ kind: "count", suffix: "requests" })
  })

  it("throws when enterprise REST usage API fails", async () => {
    const ctx = makeCtx()

    const jwtPayload = Buffer.from(
      JSON.stringify({ sub: "google-oauth2|user_abc123", exp: 9999999999 }),
      "utf8"
    )
      .toString("base64")
      .replace(/=+$/g, "")
    const accessToken = `a.${jwtPayload}.c`

    ctx.host.sqlite.query.mockReturnValue(
      JSON.stringify([{ value: accessToken }])
    )
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return { status: 500, bodyText: "" }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Enterprise usage data unavailable")
  })

  it("throws team request-based unavailable when REST usage API fails", async () => {
    const ctx = makeCtx()

    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(
      JSON.stringify([{ value: accessToken }])
    )
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1772124774973",
            billingCycleEnd: "1772124774973",
            displayThreshold: 100,
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Team" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return { status: 500, bodyText: "" }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Team request-based usage data unavailable")
  })

  it("throws team request-based unavailable when REST usage request throws", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1772124774973",
            billingCycleEnd: "1772124774973",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ planInfo: { planName: "Team" } }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        throw new Error("rest usage boom")
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Team request-based usage data unavailable")
  })

  it("falls back to REST request usage when plan info is unavailable", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1772124774973",
            billingCycleEnd: "1772124774973",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return { status: 503, bodyText: "" }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 31,
              maxRequestUsage: 500,
            },
            startOfMonth: "2026-02-09T17:36:37.000Z",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeNull()
    const reqLine = result.lines.find((l) => l.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(31)
    expect(reqLine.limit).toBe(500)
  })

  it("surfaces request-based unavailable when plan info is unavailable and REST fallback fails", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1772124774973",
            billingCycleEnd: "1772124774973",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        throw new Error("plan info timeout")
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return { status: 500, bodyText: "" }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Cursor request-based usage data unavailable")
  })

  it("does not use request-based fallback for disabled team accounts", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    let restUsageCalled = false

    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: false,
            billingCycleStart: "1772124774973",
            billingCycleEnd: "1772124774973",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ planInfo: { planName: "Team" } }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        restUsageCalled = true
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": { numRequests: 1, maxRequestUsage: 500 },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No active Cursor subscription.")
    expect(restUsageCalled).toBe(false)
  })

  it("still throws no subscription for non-enterprise accounts without planUsage", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ enabled: false }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ planInfo: { planName: "Pro" } }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No active Cursor subscription.")
  })

  it("handles plan fetch failure gracefully", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 0, limit: 100 },
          }),
        }
      }
      // Plan fetch fails
      throw new Error("plan fail")
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("outputs Credits first when available", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
            spendLimitUsage: { individualLimit: 5000, individualRemaining: 1000 },
          }),
        }
      }
      if (String(opts.url).includes("GetCreditGrantsBalance")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            hasCreditGrants: true,
            totalCents: 10000,
            usedCents: 500,
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    
    // Credits should be first in the lines array
    expect(result.lines[0].label).toBe("Credits")
    expect(result.lines[1].label).toBe("Total usage")
    // On-demand should come after
    const onDemandIndex = result.lines.findIndex((l) => l.label === "On-demand")
    expect(onDemandIndex).toBeGreaterThan(1)
  })

  it("combines credit grants with Stripe customer balance for Credits line", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      if (url.includes("GetCreditGrantsBalance")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            hasCreditGrants: true,
            totalCents: "1000000",
            usedCents: "264729",
          }),
        }
      }
      if (url.includes("/api/auth/stripe")) {
        expect(opts.headers.Cookie).toBe(
          "WorkosCursorSessionToken=user_abc123%3A%3A" + accessToken
        )
        return {
          status: 200,
          bodyText: JSON.stringify({
            customerBalance: -991544,
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const creditsLine = result.lines.find((line) => line.label === "Credits")

    expect(creditsLine).toBeTruthy()
    expect(creditsLine.used).toBeCloseTo(2647.29, 2)
    expect(creditsLine.limit).toBeCloseTo(19915.44, 2)
  })

  it("shows Credits line from Stripe balance when grants are unavailable", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      if (url.includes("GetCreditGrantsBalance")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ hasCreditGrants: false }),
        }
      }
      if (url.includes("/api/auth/stripe")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            customerBalance: -50000,
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const creditsLine = result.lines.find((line) => line.label === "Credits")

    expect(result.lines[0].label).toBe("Credits")
    expect(creditsLine).toBeTruthy()
    expect(creditsLine.used).toBe(0)
    expect(creditsLine.limit).toBe(500)
  })

  it("accepts Stripe customer balance when returned as numeric string", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      if (url.includes("GetCreditGrantsBalance")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ hasCreditGrants: false }),
        }
      }
      if (url.includes("/api/auth/stripe")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            customerBalance: "-50000",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const creditsLine = result.lines.find((line) => line.label === "Credits")

    expect(result.lines[0].label).toBe("Credits")
    expect(creditsLine).toBeTruthy()
    expect(creditsLine.used).toBe(0)
    expect(creditsLine.limit).toBe(500)
  })

  it("outputs Total usage first when Credits not available", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      if (String(opts.url).includes("GetCreditGrantsBalance")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ hasCreditGrants: false }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    
    // Total usage should be first when Credits not available
    expect(result.lines[0].label).toBe("Total usage")
  })

  it("emits Auto usage and API usage percent lines when available", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            billingCycleEnd: Date.now(),
            planUsage: {
              limit: 40000,
              remaining: 32000,
              totalPercentUsed: 20,
              autoPercentUsed: 12.5,
              apiPercentUsed: 7.5,
            },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const totalLine = result.lines.find((line) => line.label === "Total usage")
    const autoLine = result.lines.find((line) => line.label === "Auto usage")
    const apiLine = result.lines.find((line) => line.label === "API usage")

    expect(totalLine).toBeTruthy()
    expect(totalLine.used).toBe(20)
    expect(totalLine.format).toEqual({ kind: "percent" })
    expect(autoLine).toBeTruthy()
    expect(autoLine.used).toBe(12.5)
    expect(autoLine.format).toEqual({ kind: "percent" })
    expect(apiLine).toBeTruthy()
    expect(apiLine.used).toBe(7.5)
    expect(apiLine.format).toEqual({ kind: "percent" })
  })

  it("falls back to computed percent when totalPercentUsed is not finite", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        enabled: true,
        planUsage: { limit: 2400, remaining: 1200, totalPercentUsed: Number.POSITIVE_INFINITY },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const totalLine = result.lines.find((l) => l.label === "Total usage")
    expect(totalLine).toBeTruthy()
    expect(totalLine.used).toBe(50)
  })

  it("omits Auto usage and API usage when percent fields missing", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        enabled: true,
        planUsage: { limit: 40000, remaining: 32000, totalPercentUsed: 20 },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Auto usage")).toBeUndefined()
    expect(result.lines.find((line) => line.label === "API usage")).toBeUndefined()
  })

  it("team account uses dollars format for Total usage", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
            spendLimitUsage: { limitType: "team", pooledLimit: 5000, pooledRemaining: 3000 },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const totalLine = result.lines.find((line) => line.label === "Total usage")
    expect(totalLine).toBeTruthy()
    expect(totalLine.format).toEqual({ kind: "dollars" })
    expect(totalLine.used).toBe(12)
  })

  it("refreshes token when expired and persists new access token", async () => {
    const ctx = makeCtx()

    const expiredPayload = Buffer.from(JSON.stringify({ exp: 1 }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const accessToken = `a.${expiredPayload}.c`

    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: accessToken }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) {
        return JSON.stringify([{ value: "refresh" }])
      }
      return JSON.stringify([])
    })

    const newPayload = Buffer.from(JSON.stringify({ exp: 9999999999 }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const newToken = `a.${newPayload}.c`

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: newToken }) }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ enabled: true, planUsage: { totalSpend: 0, limit: 100 } }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
    expect(ctx.host.sqlite.exec).toHaveBeenCalled()
  })

  it("throws session expired when refresh requires logout and no access token exists", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) {
        return JSON.stringify([{ value: "refresh" }])
      }
      return JSON.stringify([])
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ shouldLogout: true }) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Session expired")
  })

  it("continues with existing access token when refresh fails", async () => {
    const ctx = makeCtx()

    const payload = Buffer.from(JSON.stringify({ exp: 1 }), "utf8")
      .toString("base64")
      .replace(/=+$/g, "")
    const accessToken = `a.${payload}.c`

    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: accessToken }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) {
        return JSON.stringify([{ value: "refresh" }])
      }
      return JSON.stringify([])
    })

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        // Force refresh to throw string error.
        return { status: 401, bodyText: JSON.stringify({ shouldLogout: true }) }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({ enabled: true, planUsage: { totalSpend: 0, limit: 100 } }),
      }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
  })

  it("handles invalid sqlite JSON for access token when refresh token is available", async () => {
    const ctx = makeCtx()
    const refreshedToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })

    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) return "{}"
      if (String(sql).includes("cursorAuth/refreshToken")) return JSON.stringify([{ value: "refresh" }])
      return JSON.stringify([])
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: refreshedToken }) }
      }
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return { status: 200, bodyText: JSON.stringify({ enabled: true, planUsage: { totalSpend: 0, limit: 100 } }) }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("throws not logged in when only refresh token exists but refresh returns no access token", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) return JSON.stringify([])
      if (String(sql).includes("cursorAuth/refreshToken")) return JSON.stringify([{ value: "refresh" }])
      return JSON.stringify([])
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({}) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("throws token expired when usage remains unauthorized after refresh retry", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: makeJwt({ sub: "google-oauth2|u", exp: 9999999999 }) }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) return JSON.stringify([{ value: "refresh" }])
      return JSON.stringify([])
    })

    let usageCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        usageCalls += 1
        if (usageCalls === 1) return { status: 401, bodyText: "" }
        return { status: 403, bodyText: "" }
      }
      if (String(opts.url).includes("/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: makeJwt({ sub: "google-oauth2|u", exp: 9999999999 }) }) }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token expired")
  })

  it("throws usage request failed after refresh when retried usage request errors", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: makeJwt({ sub: "google-oauth2|u", exp: 9999999999 }) }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) return JSON.stringify([{ value: "refresh" }])
      return JSON.stringify([])
    })

    let usageCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        usageCalls += 1
        if (usageCalls === 1) return { status: 401, bodyText: "" }
        throw new Error("boom")
      }
      if (String(opts.url).includes("/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: makeJwt({ sub: "google-oauth2|u", exp: 9999999999 }) }) }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed after refresh")
  })

  it("throws enterprise unavailable when token payload has no sub", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return { status: 200, bodyText: JSON.stringify({ billingCycleStart: "1770539602363" }) }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return { status: 200, bodyText: JSON.stringify({ planInfo: { planName: "Enterprise" } }) }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Enterprise usage data unavailable")
  })

  it("supports enterprise JWT sub values without provider prefix", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 3,
              maxRequestUsage: 10,
            },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("Enterprise")
    const reqLine = result.lines.find((l) => l.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(3)
    expect(reqLine.limit).toBe(10)
  })

  it("uses zero default for missing remaining and omits zero on-demand limits", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { limit: 2400 },
            spendLimitUsage: {},
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const planLine = result.lines.find((line) => line.label === "Total usage")
    expect(planLine).toBeTruthy()
    expect(planLine.used).toBe(100)
    expect(result.lines.find((line) => line.label === "On-demand")).toBeUndefined()
  })

  it("rethrows string errors from retry wrapper", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.util.retryOnceOnAuth = vi.fn(() => {
      throw "retry failed"
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("retry failed")
  })

  it("skips malformed credit grants payload and still returns total usage", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 1200, limit: 2400 },
          }),
        }
      }
      if (String(opts.url).includes("GetCreditGrantsBalance")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            hasCreditGrants: true,
            totalCents: "oops",
            usedCents: "10",
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Credits")).toBeUndefined()
    expect(result.lines.find((line) => line.label === "Total usage")).toBeTruthy()
  })

  it("uses expired access token when refresh token is missing", async () => {
    const ctx = makeCtx()
    const expiredToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 1 })
    ctx.host.sqlite.query.mockImplementation((db, sql) => {
      if (String(sql).includes("cursorAuth/accessToken")) {
        return JSON.stringify([{ value: expiredToken }])
      }
      if (String(sql).includes("cursorAuth/refreshToken")) return JSON.stringify([])
      return JSON.stringify([])
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            enabled: true,
            planUsage: { totalSpend: 0, limit: 100 },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
  })

  it("throws enterprise unavailable when sub resolves to empty user id", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return { status: 200, bodyText: JSON.stringify({ billingCycleStart: "1770539602363" }) }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return { status: 200, bodyText: JSON.stringify({ planInfo: { planName: "Enterprise" } }) }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Enterprise usage data unavailable")
  })

  it("uses zero included requests when enterprise usage omits numRequests", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              maxRequestUsage: 10,
            },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const reqLine = result.lines.find((line) => line.label === "Requests")
    expect(reqLine).toBeTruthy()
    expect(reqLine.used).toBe(0)
    expect(reqLine.limit).toBe(10)
  })

  it("throws enterprise unavailable when gpt-4 request limit is not positive", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 42,
              maxRequestUsage: 0,
            },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Enterprise usage data unavailable")
  })

  it("omits enterprise plan label when formatter returns null", async () => {
    const ctx = makeCtx()
    const accessToken = makeJwt({ sub: "google-oauth2|user_abc123", exp: 9999999999 })
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: accessToken }]))
    ctx.fmt.planLabel = vi.fn(() => null)
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("GetCurrentPeriodUsage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            billingCycleStart: "1770539602363",
            billingCycleEnd: "1770539602363",
          }),
        }
      }
      if (String(opts.url).includes("GetPlanInfo")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            planInfo: { planName: "Enterprise" },
          }),
        }
      }
      if (String(opts.url).includes("cursor.com/api/usage")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            "gpt-4": {
              numRequests: 3,
              maxRequestUsage: 10,
            },
          }),
        }
      }
      return { status: 200, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeNull()
    expect(result.lines.find((line) => line.label === "Requests")).toBeTruthy()
  })

  it("wraps non-string retry wrapper errors as usage request failure", async () => {
    const ctx = makeCtx()
    ctx.host.sqlite.query.mockReturnValue(JSON.stringify([{ value: "token" }]))
    ctx.util.retryOnceOnAuth = vi.fn(() => {
      throw new Error("wrapper blew up")
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed. Check your connection.")
  })
})
