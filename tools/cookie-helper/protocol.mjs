export async function executeRequest(request, runtime) {
  if (request?.version !== 1) {
    return errorResponse(
      operationName(request),
      "UnsupportedVersion",
      "This browser helper protocol version is not supported.",
    )
  }

  if (request.operation === "ListProfiles") {
    if (!hasOnlyKeys(request, ["version", "operation", "browser"])) {
      return errorResponse(
        "ListProfiles",
        "InvalidRequest",
        "ListProfiles accepts only version, operation, and browser.",
      )
    }
    if (!isSupportedBrowser(request.browser)) {
      return errorResponse(
        "ListProfiles",
        "UnsupportedBrowser",
        "Only Chrome and Arc are supported.",
      )
    }
    let profiles
    try {
      profiles = await runtime.listProfiles(request.browser)
    } catch {
      return errorResponse(
        "ListProfiles",
        "ProfileDiscoveryFailed",
        "Browser profiles could not be listed.",
      )
    }
    return {
      version: 1,
      operation: "ListProfiles",
      ok: true,
      browser: request.browser,
      profiles,
    }
  }

  if (request.operation === "ReadCookies") {
    if (
      !hasOnlyKeys(request, ["version", "operation", "browser", "profileKey", "provider"])
    ) {
      return errorResponse(
        "ReadCookies",
        "InvalidRequest",
        "ReadCookies accepts only version, operation, browser, profileKey, and provider.",
      )
    }
    if (!isSupportedBrowser(request.browser)) {
      return errorResponse(
        "ReadCookies",
        "UnsupportedBrowser",
        "Only Chrome and Arc are supported.",
      )
    }
    if (!Object.hasOwn(PROVIDER_POLICIES, request.provider)) {
      return errorResponse(
        "ReadCookies",
        "UnsupportedProvider",
        "Only Cursor and Claude browser sessions are supported.",
      )
    }
    const policy = PROVIDER_POLICIES[request.provider]
    if (!isExactProfileKey(request.profileKey)) {
      return errorResponse(
        "ReadCookies",
        "InvalidProfileKey",
        "Choose one exact browser profile.",
      )
    }
    let result
    try {
      result = await runtime.readCookies({
        browser: request.browser,
        profileKey: request.profileKey,
        provider: request.provider,
        policy,
      })
    } catch {
      return errorResponse(
        "ReadCookies",
        "CookieReadFailed",
        "Browser cookies could not be read.",
      )
    }
    const candidates = groupCandidates(
      result.cookies,
      request.profileKey,
      policy,
      runtime.serializeCookies,
    )
    return {
      version: 1,
      operation: "ReadCookies",
      ok: true,
      browser: request.browser,
      profileKey: request.profileKey,
      provider: request.provider,
      candidates,
      warnings: result.warnings?.length
        ? [
            {
              code: "CookieReadWarning",
              message: "Some browser cookies could not be read.",
            },
          ]
        : [],
    }
  }

  return errorResponse(
    operationName(request),
    "UnsupportedOperation",
    "This browser helper operation is not supported.",
  )
}

const PROVIDER_POLICIES = {
  Cursor: {
    url: "https://cursor.com/",
    origins: [
      "https://www.cursor.com/",
      "https://cursor.sh/",
      "https://authenticator.cursor.sh/",
    ],
    timeoutMs: 12_000,
    includeExpired: false,
    mode: "merge",
    hosts: ["cursor.com", "www.cursor.com", "cursor.sh", "authenticator.cursor.sh"],
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
  Claude: {
    url: "https://claude.ai/",
    origins: [],
    timeoutMs: 12_000,
    includeExpired: false,
    mode: "merge",
    hosts: ["claude.ai"],
    names: ["sessionKey"],
  },
}

function errorResponse(operation, code, message) {
  return {
    version: 1,
    operation,
    ok: false,
    error: { code, message },
  }
}

function operationName(request) {
  return typeof request?.operation === "string" ? request.operation : "Unknown"
}

function hasOnlyKeys(value, allowedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isSupportedBrowser(browser) {
  return browser === "Chrome" || browser === "Arc"
}

function isExactProfileKey(profileKey) {
  return (
    typeof profileKey === "string" &&
    profileKey.length >= 1 &&
    profileKey.length <= 128 &&
    profileKey.trim() === profileKey &&
    profileKey !== "." &&
    profileKey !== ".." &&
    profileKey !== "All Profiles" &&
    !/[\\/\u0000-\u001f\u007f]/u.test(profileKey)
  )
}

function groupCandidates(cookies, profileKey, policy, serializeCookies) {
  const groups = new Map()
  const allowedNames = new Set(policy.names)
  const allowedHosts = new Set(policy.hosts)

  for (const cookieValue of Array.isArray(cookies) ? cookies : []) {
    const host = normalizedCookieHost(cookieValue)
    const storeId = normalizedStoreId(cookieValue?.source?.storeId)
    if (
      cookieValue?.source?.browser !== "chrome" ||
      cookieValue?.source?.profile !== profileKey ||
      !allowedNames.has(cookieValue?.name) ||
      !allowedHosts.has(host) ||
      storeId === null
    ) {
      continue
    }

    const key = JSON.stringify([storeId, host])
    const group = groups.get(key) ?? { storeId, host, cookies: [] }
    group.cookies.push(cookieValue)
    groups.set(key, group)
  }

  return Array.from(groups.values())
    .sort((left, right) => policy.hosts.indexOf(left.host) - policy.hosts.indexOf(right.host))
    .map(({ storeId, host, cookies: groupedCookies }) => ({
      storeId,
      host,
      cookieHeader: serializeCookies(groupedCookies, {
        dedupeByName: false,
        sort: "none",
      }),
    }))
}

function normalizedCookieHost(cookieValue) {
  let candidate = typeof cookieValue?.domain === "string" ? cookieValue.domain : ""
  if (!candidate && typeof cookieValue?.url === "string") {
    try {
      candidate = new URL(cookieValue.url).hostname
    } catch {
      return ""
    }
  }
  return candidate.trim().replace(/^\.+/, "").replace(/\.$/, "").toLowerCase()
}

function normalizedStoreId(storeId) {
  if (typeof storeId !== "string" || !storeId || /[\u0000-\u001f\u007f]/u.test(storeId)) {
    return null
  }
  return storeId
}
