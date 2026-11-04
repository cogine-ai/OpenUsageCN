import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./auth.js")
  await import("./quota.js")
  await import("./summary.js")
  await import("./plugin.js")
  const plugin = globalThis.__openusage_plugin
  return { ...plugin, probe(ctx) {
    const request = ctx.host.http.request
    const legacy = { ...ctx, host: { ...ctx.host, http: { ...ctx.host.http, request(options) {
      if (String(options.url).includes("retrieveUserQuotaSummary") || String(options.url).includes("loadCodeAssist") && options.headers["User-Agent"] !== "agy") {
        return { status: 404, bodyText: "{}" }
      }
      return request(options)
    } } } }
    return plugin.probe(legacy)
  } }
}

const OAUTH_TOKEN_KEY = "antigravityUnifiedStateSync.oauthToken"
const OAUTH_TOKEN_SENTINEL = "oauthTokenInfoSentinelKey"
const STATE_DB_V2 = "~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb"
const STATE_DB_V1 = "~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
const LOGIN_MESSAGE = "Start Antigravity or run `agy` and try again."

// --- Fixtures ---

function makeDiscovery(overrides) {
  return Object.assign(
    { pid: 12345, csrf: "test-csrf-token", ports: [42001, 42002], extensionPort: null },
    overrides
  )
}

function makeUserStatusResponse(overrides) {
  var base = {
    userStatus: {
      planStatus: {
        planInfo: {
          planName: "Pro",
          monthlyPromptCredits: 50000,
          monthlyFlowCredits: 150000,
          monthlyFlexCreditPurchaseAmount: 25000,
        },
        availablePromptCredits: 500,
        availableFlowCredits: 100,
        usedFlexCredits: 5000,
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Gemini 3.1 Pro (High)",
            modelOrAlias: { model: "MODEL_PLACEHOLDER_M37" },
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-02-08T09:10:56Z" },
          },
          {
            label: "Gemini 3.1 Pro (Low)",
            modelOrAlias: { model: "MODEL_PLACEHOLDER_M36" },
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-02-08T09:10:56Z" },
          },
          {
            label: "Gemini 3 Flash",
            modelOrAlias: { model: "MODEL_PLACEHOLDER_M18" },
            quotaInfo: { remainingFraction: 1.0, resetTime: "2026-02-08T09:10:56Z" },
          },
          {
            label: "Claude Sonnet 4.6 (Thinking)",
            modelOrAlias: { model: "MODEL_PLACEHOLDER_M35" },
            quotaInfo: { remainingFraction: 0, resetTime: "2026-02-26T15:23:41Z" },
          },
          {
            label: "Claude Opus 4.6 (Thinking)",
            modelOrAlias: { model: "MODEL_PLACEHOLDER_M26" },
            quotaInfo: { remainingFraction: 0, resetTime: "2026-02-26T15:23:41Z" },
          },
          {
            label: "GPT-OSS 120B (Medium)",
            modelOrAlias: { model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM" },
            quotaInfo: { remainingFraction: 0, resetTime: "2026-02-26T15:23:41Z" },
          },
        ],
      },
    },
  }
  if (overrides) {
    if (overrides.planName !== undefined) base.userStatus.planStatus.planInfo.planName = overrides.planName
    if (overrides.configs !== undefined) base.userStatus.cascadeModelConfigData.clientModelConfigs = overrides.configs
    if (overrides.planStatus !== undefined) base.userStatus.planStatus = overrides.planStatus
    if (overrides.userTier !== undefined) base.userStatus.userTier = overrides.userTier
  }
  return base
}

function makeCloudCodeResponse(overrides) {
  return Object.assign(
    {
      models: {
        "gemini-3-pro": {
          displayName: "Gemini 3 Pro",
          model: "gemini-3-pro",
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-02-08T10:00:00Z" },
        },
        "claude-sonnet-4.5": {
          displayName: "Claude Sonnet 4.5",
          model: "claude-sonnet-4.5",
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-02-08T10:00:00Z" },
        },
      },
    },
    overrides
  )
}

function makeAgyLoadResponse(overrides) {
  return Object.assign(
    {
      paidTier: { name: "Google AI Pro" },
      cloudaicompanionProject: "projects/openusagecn-agy",
    },
    overrides
  )
}

function makeAgyQuotaResponse(overrides) {
  return Object.assign(
    {
      buckets: [
        { modelId: "gemini-3-pro", remainingFraction: 0.8, resetTime: "2026-02-08T10:00:00Z" },
        { modelId: "gemini-3-flash", remainingFraction: 0.6, resetTime: "2026-02-08T10:00:00Z" },
        { modelId: "claude-sonnet-4.5", remainingFraction: 0.4, resetTime: "2026-02-08T10:00:00Z" },
      ],
    },
    overrides
  )
}

function setupLsMock(ctx, discovery, responseBody) {
  ctx.host.ls.discover.mockReturnValue(discovery)
  ctx.host.http.request.mockImplementation((opts) => {
    if (String(opts.url).includes("GetUnleashData")) {
      return { status: 200, bodyText: "{}" }
    }
    return { status: 200, bodyText: JSON.stringify(responseBody) }
  })
}

function setupSqliteMock(ctx, oauthEnvelopeB64) {
  ctx.host.sqlite.query.mockImplementation((db, sql) => {
    if (sql.includes(OAUTH_TOKEN_KEY) && oauthEnvelopeB64) {
      return JSON.stringify([{ value: oauthEnvelopeB64 }])
    }
    return "[]"
  })
}

function setupSqliteByPath(ctx, valuesByPath) {
  ctx.host.sqlite.query.mockImplementation((db, sql) => {
    if (!sql.includes(OAUTH_TOKEN_KEY)) return "[]"
    var value = valuesByPath[String(db)]
    if (value instanceof Error) throw value
    if (value) return JSON.stringify([{ value: value }])
    return "[]"
  })
}

function encodeVarint(n) {
  var bytes = ""
  while (n > 0x7f) {
    bytes += String.fromCharCode((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  bytes += String.fromCharCode(n & 0x7f)
  return bytes
}

function encodeField(fieldNum, wireType, data) {
  var tag = encodeVarint(fieldNum * 8 + wireType)
  if (wireType === 2) return tag + encodeVarint(data.length) + data
  if (wireType === 0) return tag + encodeVarint(data)
  return ""
}

function makeOAuthSentinelB64(ctx, opts) {
  opts = opts || {}
  var inner = ""
  if (opts.accessToken) inner += encodeField(1, 2, opts.accessToken)
  if (opts.refreshToken) inner += encodeField(3, 2, opts.refreshToken)
  if (opts.expirySeconds !== null && opts.expirySeconds !== undefined) {
    var tsMsg = encodeField(1, 0, opts.expirySeconds)
    inner += encodeField(4, 2, tsMsg)
  }
  var innerB64 = ctx.base64.encode(inner)
  var payload = encodeField(1, 2, innerB64)
  var wrapper = encodeField(1, 2, OAUTH_TOKEN_SENTINEL) + encodeField(2, 2, payload)
  var outer = encodeField(1, 2, wrapper)
  return ctx.base64.encode(outer)
}


export { loadPlugin, OAUTH_TOKEN_KEY, OAUTH_TOKEN_SENTINEL, STATE_DB_V2, STATE_DB_V1, LOGIN_MESSAGE, makeDiscovery, makeUserStatusResponse, makeCloudCodeResponse, makeAgyLoadResponse, makeAgyQuotaResponse, setupLsMock, setupSqliteMock, setupSqliteByPath, encodeVarint, encodeField, makeOAuthSentinelB64 }
