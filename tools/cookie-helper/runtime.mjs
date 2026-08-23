import { lstat, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { getCookies, toCookieHeader } from "@steipete/sweet-cookie"

export function createCookieRuntime(options = {}) {
  const applicationSupportDirectory =
    options.applicationSupportDirectory ??
    path.join(homedir(), "Library", "Application Support")
  const readWithSweetCookie = options.cookieLibrary?.getCookies ?? getCookies

  return {
    listProfiles: (browser) => listProfiles(applicationSupportDirectory, browser),
    readCookies: (request) =>
      readCookies(applicationSupportDirectory, request, readWithSweetCookie),
    serializeCookies: toCookieHeader,
  }
}

async function readCookies(applicationSupportDirectory, request, readWithSweetCookie) {
  const root = browserRoot(applicationSupportDirectory, request.browser)
  const profilePath = path.resolve(root, request.profileKey)
  if (
    path.dirname(profilePath) !== path.resolve(root) ||
    path.basename(profilePath) !== request.profileKey
  ) {
    throw new Error("Invalid profile key")
  }
  const profileMetadata = await lstat(profilePath)
  if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) {
    throw new Error("Profile is not a directory")
  }

  return readWithSweetCookie({
    url: request.policy.url,
    origins: [...request.policy.origins],
    names: [...request.policy.names],
    browsers: ["chrome"],
    chromiumBrowser: request.browser === "Chrome" ? "chrome" : "arc",
    chromeProfile: profilePath,
    timeoutMs: request.policy.timeoutMs,
    includeExpired: request.policy.includeExpired,
    debug: false,
    mode: request.policy.mode,
  })
}

async function listProfiles(applicationSupportDirectory, browser) {
  const root = browserRoot(applicationSupportDirectory, browser)
  const [entries, aliases] = await Promise.all([
    readdir(root, { withFileTypes: true }),
    readProfileAliases(root),
  ])

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        isSafeProfileKey(entry.name) &&
        (aliases.has(entry.name) || entry.name === "Default" || /^Profile \d+$/u.test(entry.name)),
    )
    .map((entry) => ({
      profileKey: entry.name,
      displayName: safeDisplayName(aliases.get(entry.name), entry.name),
    }))
    .sort(compareProfiles)
}

function browserRoot(applicationSupportDirectory, browser) {
  if (browser === "Chrome") {
    return path.join(applicationSupportDirectory, "Google", "Chrome")
  }
  if (browser === "Arc") {
    return path.join(applicationSupportDirectory, "Arc", "User Data")
  }
  throw new Error("Unsupported browser")
}

async function readProfileAliases(root) {
  try {
    const localState = JSON.parse(await readFile(path.join(root, "Local State"), "utf8"))
    const infoCache = localState?.profile?.info_cache
    if (typeof infoCache !== "object" || infoCache === null || Array.isArray(infoCache)) {
      return new Map()
    }
    return new Map(
      Object.entries(infoCache).map(([profileKey, metadata]) => [
        profileKey,
        typeof metadata === "object" && metadata !== null ? metadata.name : undefined,
      ]),
    )
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return new Map()
    }
    throw error
  }
}

function safeDisplayName(candidate, fallback) {
  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    return fallback
  }
  return candidate.trim().slice(0, 128)
}

function isSafeProfileKey(profileKey) {
  return (
    profileKey.length >= 1 &&
    profileKey.length <= 128 &&
    profileKey.trim() === profileKey &&
    !/[\u0000-\u001f\u007f]/u.test(profileKey)
  )
}

function compareProfiles(left, right) {
  if (left.profileKey === "Default") return -1
  if (right.profileKey === "Default") return 1
  return left.profileKey.localeCompare(right.profileKey, "en", { numeric: true })
}
