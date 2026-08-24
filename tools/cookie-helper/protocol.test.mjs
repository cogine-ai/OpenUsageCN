import assert from "node:assert/strict"
import test from "node:test"

import { executeRequest } from "./protocol.mjs"

test("ListProfiles returns only canonical profile metadata", async () => {
  let cookieReads = 0
  const response = await executeRequest(
    {
      version: 1,
      operation: "ListProfiles",
      browser: "Chrome",
    },
    {
      listProfiles: async () => [
        { profileKey: "Default", displayName: "Personal" },
        { profileKey: "Profile 2", displayName: "Work" },
      ],
      readCookies: async () => {
        cookieReads += 1
        return { cookies: [], warnings: [] }
      },
    },
  )

  assert.deepEqual(response, {
    version: 1,
    operation: "ListProfiles",
    ok: true,
    browser: "Chrome",
    profiles: [
      { profileKey: "Default", displayName: "Personal" },
      { profileKey: "Profile 2", displayName: "Work" },
    ],
  })
  assert.equal(cookieReads, 0)
})

test("unsupported protocol versions fail with a stable nonsecret error", async () => {
  const response = await executeRequest(
    {
      version: 2,
      operation: "ReadCookies",
      browser: "Chrome",
      profileKey: "/Users/alice/Private/Profile 2",
      provider: "Cursor",
      cookieHeader: "session=super-secret",
    },
    {
      listProfiles: async () => {
        throw new Error("must not run")
      },
      readCookies: async () => {
        throw new Error("must not run")
      },
    },
  )

  assert.deepEqual(response, {
    version: 1,
    operation: "ReadCookies",
    ok: false,
    error: {
      code: "UnsupportedVersion",
      message: "This browser helper protocol version is not supported.",
    },
  })
})

test("ListProfiles rejects cookie-reading fields", async () => {
  const response = await executeRequest(
    {
      version: 1,
      operation: "ListProfiles",
      browser: "Arc",
      provider: "Claude",
    },
    {
      listProfiles: async () => {
        throw new Error("must not run")
      },
      readCookies: async () => {
        throw new Error("must not run")
      },
    },
  )

  assert.deepEqual(response, {
    version: 1,
    operation: "ListProfiles",
    ok: false,
    error: {
      code: "InvalidRequest",
      message: "ListProfiles accepts only version, operation, and browser.",
    },
  })
})

test("ListProfiles supports only Chrome and Arc", async () => {
  const response = await executeRequest(
    { version: 1, operation: "ListProfiles", browser: "Safari" },
    {
      listProfiles: async () => {
        throw new Error("must not run")
      },
      readCookies: async () => {
        throw new Error("must not run")
      },
    },
  )

  assert.equal(response.error.code, "UnsupportedBrowser")
})

test("ReadCookies preserves duplicate names while isolating stores and hosts", async () => {
  const response = await executeRequest(
    {
      version: 1,
      operation: "ReadCookies",
      browser: "Chrome",
      profileKey: "Profile 2",
      provider: "Cursor",
    },
    {
      listProfiles: async () => [],
      readCookies: async () => ({
        cookies: [
          cookie("WorkosCursorSessionToken", "first", ".cursor.com", "/", "store-a"),
          cookie("WorkosCursorSessionToken", "second", "cursor.com", "/nested", "store-a"),
          cookie("next-auth.session-token", "www", "www.cursor.com", "/", "store-a"),
          cookie("wos-session", "other-store", "cursor.com", "/", "store-b"),
          cookie("sessionKey", "wrong-name", "cursor.com", "/", "store-a"),
          cookie("wos-session", "wrong-host", "evil.example", "/", "store-a"),
          cookie("wos-session", "wrong-profile", "cursor.com", "/", "store-a", "Default"),
        ],
        warnings: ["Failed at /Users/alice/Private with Cookie: session=super-secret"],
      }),
      serializeCookies: (cookies) =>
        cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
    },
  )

  assert.deepEqual(response, {
    version: 1,
    operation: "ReadCookies",
    ok: true,
    browser: "Chrome",
    profileKey: "Profile 2",
    provider: "Cursor",
    candidates: [
      {
        storeId: "store-a",
        host: "cursor.com",
        cookieHeader:
          "WorkosCursorSessionToken=first; WorkosCursorSessionToken=second",
      },
      {
        storeId: "store-b",
        host: "cursor.com",
        cookieHeader: "wos-session=other-store",
      },
      {
        storeId: "store-a",
        host: "www.cursor.com",
        cookieHeader: "next-auth.session-token=www",
      },
    ],
    warnings: [
      {
        code: "CookieReadWarning",
        message: "Some browser cookies could not be read.",
      },
    ],
  })
})

test("ReadCookies rejects requests outside the exact allowlist before browser access", async () => {
  const base = {
    version: 1,
    operation: "ReadCookies",
    browser: "Arc",
    profileKey: "Default",
    provider: "Claude",
  }
  const cases = [
    [{ ...base, browser: "Safari" }, "UnsupportedBrowser"],
    [{ ...base, provider: "OpenAI" }, "UnsupportedProvider"],
    [{ ...base, provider: "toString" }, "UnsupportedProvider"],
    [{ ...base, provider: "__proto__" }, "UnsupportedProvider"],
    [{ ...base, profileKey: "All Profiles" }, "InvalidProfileKey"],
    [{ ...base, profileKey: "../Default" }, "InvalidProfileKey"],
    [{ ...base, domains: ["evil.example"] }, "InvalidRequest"],
    [{ version: 1, operation: "DumpAll", browser: "Chrome" }, "UnsupportedOperation"],
  ]
  const observed = []

  for (const [request, expectedCode] of cases) {
    const response = await executeRequest(request, {
      listProfiles: async () => {
        throw new Error("must not run")
      },
      readCookies: async () => {
        throw new Error("must not run")
      },
      serializeCookies: () => {
        throw new Error("must not run")
      },
    })
    observed.push([response.error.code, expectedCode])
  }

  assert.deepEqual(observed, cases.map(([, expectedCode]) => [expectedCode, expectedCode]))
})

test("ReadCookies passes fixed Cursor and Claude policies to the browser adapter", async () => {
  const observed = []
  const runtime = {
    listProfiles: async () => [],
    readCookies: async (options) => {
      observed.push(options)
      return { cookies: [], warnings: [] }
    },
    serializeCookies: () => "",
  }

  await executeRequest(
    {
      version: 1,
      operation: "ReadCookies",
      browser: "Chrome",
      profileKey: "Default",
      provider: "Cursor",
    },
    runtime,
  )
  await executeRequest(
    {
      version: 1,
      operation: "ReadCookies",
      browser: "Arc",
      profileKey: "Profile 3",
      provider: "Claude",
    },
    runtime,
  )

  assert.deepEqual(observed, [
    {
      browser: "Chrome",
      profileKey: "Default",
      provider: "Cursor",
      policy: {
        url: "https://cursor.com/",
        origins: [
          "https://www.cursor.com/",
          "https://cursor.sh/",
          "https://authenticator.cursor.sh/",
        ],
        timeoutMs: 12_000,
        includeExpired: false,
        mode: "merge",
        hosts: [
          "cursor.com",
          "www.cursor.com",
          "cursor.sh",
          "authenticator.cursor.sh",
        ],
        names: [
          "WorkosCursorSessionToken",
          "__Secure-next-auth.session-token",
          "next-auth.session-token",
          "wos-session",
          "__Secure-wos-session",
          "authjs.session-token",
          "__Secure-authjs.session-token",
        ],
      },
    },
    {
      browser: "Arc",
      profileKey: "Profile 3",
      provider: "Claude",
      policy: {
        url: "https://claude.ai/",
        origins: [],
        timeoutMs: 12_000,
        includeExpired: false,
        mode: "merge",
        hosts: ["claude.ai"],
        names: ["sessionKey"],
      },
    },
  ])
})

test("browser adapter failures never echo cookie values or profile paths", async () => {
  const runtime = {
    listProfiles: async () => {
      throw new Error("/Users/alice/Private/Profile 9")
    },
    readCookies: async () => {
      throw new Error("Cookie: session=super-secret")
    },
    serializeCookies: () => "",
  }

  const listResponse = await executeRequest(
    { version: 1, operation: "ListProfiles", browser: "Chrome" },
    runtime,
  )
  const readResponse = await executeRequest(
    {
      version: 1,
      operation: "ReadCookies",
      browser: "Arc",
      profileKey: "Profile 9",
      provider: "Claude",
    },
    runtime,
  )

  assert.deepEqual([listResponse, readResponse], [
    {
      version: 1,
      operation: "ListProfiles",
      ok: false,
      error: {
        code: "ProfileDiscoveryFailed",
        message: "Browser profiles could not be listed.",
      },
    },
    {
      version: 1,
      operation: "ReadCookies",
      ok: false,
      error: {
        code: "CookieReadFailed",
        message: "Browser cookies could not be read.",
      },
    },
  ])
})

function cookie(name, value, domain, path, storeId, profile = "Profile 2") {
  return {
    name,
    value,
    domain,
    path,
    source: {
      browser: "chrome",
      profile,
      storeId,
    },
  }
}
