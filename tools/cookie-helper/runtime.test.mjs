import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { executeRequest } from "./protocol.mjs"
import { createCookieRuntime } from "./runtime.mjs"

test("ListProfiles discovers Chrome and Arc metadata without a Cookie database", async (context) => {
  const applicationSupportDirectory = await mkdtemp(
    path.join(tmpdir(), "openusage-cookie-helper-profiles-"),
  )
  context.after(() => rm(applicationSupportDirectory, { recursive: true, force: true }))

  await createBrowserFixture(applicationSupportDirectory, "Chrome", {
    Default: "Personal",
    "Profile 2": "Work",
    "Profile 8": "Stale",
    "Bad\nProfile": "Unsafe",
  })
  await mkdir(
    path.join(applicationSupportDirectory, "Google", "Chrome", "Profile 3"),
    { recursive: true },
  )
  await mkdir(path.join(applicationSupportDirectory, "Google", "Chrome", "Cache"), {
    recursive: true,
  })
  await createBrowserFixture(applicationSupportDirectory, "Arc", {
    Default: "Personal Arc",
    "Profile 4": "Work Arc",
  })

  const runtime = createCookieRuntime({ applicationSupportDirectory })
  const chrome = await executeRequest(
    { version: 1, operation: "ListProfiles", browser: "Chrome" },
    runtime,
  )
  const arc = await executeRequest(
    { version: 1, operation: "ListProfiles", browser: "Arc" },
    runtime,
  )

  assert.deepEqual([chrome.profiles, arc.profiles], [
    [
      { profileKey: "Default", displayName: "Personal" },
      { profileKey: "Profile 2", displayName: "Work" },
      { profileKey: "Profile 3", displayName: "Profile 3" },
    ],
    [
      { profileKey: "Default", displayName: "Personal Arc" },
      { profileKey: "Profile 4", displayName: "Work Arc" },
    ],
  ])
})

test("ReadCookies calls sweet-cookie for one exact Chrome or Arc profile", async (context) => {
  const applicationSupportDirectory = await mkdtemp(
    path.join(tmpdir(), "openusage-cookie-helper-read-"),
  )
  context.after(() => rm(applicationSupportDirectory, { recursive: true, force: true }))
  const chromeProfile = path.join(
    applicationSupportDirectory,
    "Google",
    "Chrome",
    "Profile 2",
  )
  const arcProfile = path.join(applicationSupportDirectory, "Arc", "User Data", "Default")
  await mkdir(chromeProfile, { recursive: true })
  await mkdir(arcProfile, { recursive: true })

  const observed = []
  const runtime = createCookieRuntime({
    applicationSupportDirectory,
    cookieLibrary: {
      getCookies: async (options) => {
        observed.push(options)
        return { cookies: [], warnings: [] }
      },
    },
  })

  await executeRequest(
    {
      version: 1,
      operation: "ReadCookies",
      browser: "Chrome",
      profileKey: "Profile 2",
      provider: "Cursor",
    },
    runtime,
  )
  await executeRequest(
    {
      version: 1,
      operation: "ReadCookies",
      browser: "Arc",
      profileKey: "Default",
      provider: "Claude",
    },
    runtime,
  )

  assert.deepEqual(observed, [
    {
      url: "https://cursor.com/",
      origins: [
        "https://www.cursor.com/",
        "https://cursor.sh/",
        "https://authenticator.cursor.sh/",
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
      browsers: ["chrome"],
      chromiumBrowser: "chrome",
      chromeProfile,
      timeoutMs: 12_000,
      includeExpired: false,
      debug: false,
      mode: "merge",
    },
    {
      url: "https://claude.ai/",
      origins: [],
      names: ["sessionKey"],
      browsers: ["chrome"],
      chromiumBrowser: "arc",
      chromeProfile: arcProfile,
      timeoutMs: 12_000,
      includeExpired: false,
      debug: false,
      mode: "merge",
    },
  ])
})

async function createBrowserFixture(applicationSupportDirectory, browser, profiles) {
  const root =
    browser === "Chrome"
      ? path.join(applicationSupportDirectory, "Google", "Chrome")
      : path.join(applicationSupportDirectory, "Arc", "User Data")
  for (const profileKey of Object.keys(profiles)) {
    if (profileKey !== "Profile 8") {
      await mkdir(path.join(root, profileKey), { recursive: true })
    }
  }
  await writeFile(
    path.join(root, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: Object.fromEntries(
          Object.entries(profiles).map(([profileKey, name]) => [profileKey, { name }]),
        ),
      },
    }),
  )
}
