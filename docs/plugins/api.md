# Host API Reference

This document describes the host APIs available to plugins via the `ctx` object passed to `probe(ctx)`.

## Supporting Scripts And Server Reports

`plugin.json` may declare ordered `supportingScripts` before `entry`. All are classic scripts
evaluated in the same fresh QuickJS context. Paths must resolve to distinct files inside the plugin
directory. This does not add Node imports, dynamic loading, or host permissions.

Codex, OpenRouter and Ollama may expose `probeReports(ctx)` for their independent **Server Reports**
action. Return `{ scopeKey, lines, reports }`: `scopeKey` is a lowercase SHA-256 binding the selected
source, identity/workspace and credential generation; `lines` contains only text/barChart.
`reports` entries contain `id`, `label`, `status`, optional `message`, `retryAt` and UTC `coverage`
(`fromDate`, `toDate`, `timeZone`, `reportedDates`, `missingDates`). Status is ready, partial,
notSupported, permissionDenied, rateLimited, authExpired or error. Missing dates stay missing.
Use text for negative credit adjustments; the existing barChart contract accepts nonnegative values.

The host adds providerId, requestId and fetchedAt, validates the output, and limits the whole call
to 60 seconds. New requests replace older requests for the same provider. Cancellation matches the
exact requestId, so an old page cannot cancel a newer request. Reports never replace quota or
local-history outputs. Check the same credential source again before returning scoped data.

`OLLAMA_API_KEY` is available only to the Ollama plugin, alongside its existing Cookie variable.
Other plugins cannot read it. Connection secrets saved in Settings use the existing local
`providers.json` mechanism; they are masked in the UI, not stored in Keychain by this API.

## Context Object

```typescript
type ProbeContext = {
  nowIso: string              // Current UTC time (ISO 8601)
  app: {
    version: string           // App version
    platform: string          // OS platform (e.g., "macos")
    appDataDir: string        // App data directory
    pluginDataDir: string     // Plugin-specific data dir (auto-created)
  }
  host: HostApi
}
```

### `ctx.nowIso`

Current UTC timestamp in ISO 8601 format (e.g., `2026-01-15T12:30:00.000Z`).

### `ctx.app`

Application metadata:

| Property        | Description                                             |
| --------------- | ------------------------------------------------------- |
| `version`       | App version string                                      |
| `platform`      | OS platform (e.g., `"macos"`, `"windows"`, `"linux"`)   |
| `appDataDir`    | App's data directory path                               |
| `pluginDataDir` | Plugin-specific data directory (auto-created on demand) |

The `pluginDataDir` is unique per plugin (`{appDataDir}/plugins_data/{pluginId}/`) and is automatically created when the plugin runs. Use it to store config files, cached data, or state.

On Windows, `appDataDir` is under `%LOCALAPPDATA%\ai.cogine.openusagecn`; non-secret app preferences are stored separately under `%APPDATA%\ai.cogine.openusagecn`. Plugins should use the provided paths instead of constructing an OpenUsageCN data path themselves.

### Windows MVP Limits

The Windows MVP runs `codex`, `bigmodel-cn`, `openai-api`, `openrouter`, `zai`, `deepseek`, `moonshot`, `ollama`, `doubao`, `xai`, `claude-platform`, `workbuddy`, `trae-cn`, `litellm`, `siliconflow`, and `muse`. Codex is enabled by default. Windows launch plugins may use filesystem, environment, provider config, HTTP, crypto, and line-building APIs, but must not depend on the macOS Keychain or `ccusage`. Use `ctx.app.platform === "windows"` when a plugin needs a platform-specific credential path or optional metric.

## Account Capability Declarations

Startup [automatic provider enablement](../provider-enablement.md) is an app-owned, local-only credential check. It is separate from `accountSupport.localDiscovery`, which discovers accounts within an already enabled provider. Currently the startup check supports DeepSeek, Moonshot, Ollama Cloud, Doubao, and xAI.

Account-related features are declared through the optional `accountSupport` object in `plugin.json`, not through methods on `ctx.host`. The declaration only advertises app-owned account experiences and does not expand a plugin's access to credentials, browsers, the filesystem, or the network. See [Manifest Schema](./schema.md#account-support-optional) for the available flags and legacy behavior.

When `localDiscovery` is enabled, the entry script also provides these account-aware callbacks:

```javascript
globalThis.__openusage_plugin = {
  id: "my-provider",
  discoverConnections(ctx) {
    return {
      observations: [{
        identityNamespace: "provider-sub-v1",
        normalizedIdentity: "stable-provider-subject",
        connectionKey: "provider-desktop",
        connectionKind: "desktop",
      }],
      sourceOutcomes: [{ sourceKey: "provider-desktop", status: "available" }],
      defaultConnectionKey: "provider-desktop",
    }
  },
  credentialGeneration(ctx, { connectionKey }) {
    return ctx.host.crypto.sha256Hex("credential state for " + connectionKey)
  },
  probe(ctx, { connectionKey, credentialGeneration }) {
    // Read only this connection and reject a generation mismatch before use.
    return { lines: [] }
  },
}
```

`connectionKind` is `desktop`, `cli`, `chrome`, or `arc`; source status is `available`, `absent`, or `unavailable`. `connectionKey` must be a nonsecret locator that is safe to persist. `normalizedIdentity` is process-only and is converted to an installation-scoped fingerprint before account storage; plugins must not log, display, or persist it themselves. `credentialGeneration` must return a lowercase 64-character SHA-256 value over the exact selected credential state, never the credential itself.

The coordinator passes only the selected connection key and its checked generation to the scoped `probe` call. Browser binding and model-history transports remain app-owned integrations for supported bundled providers; declaring their flags alone does not expose cookies or add a general-purpose browser API to plugin JavaScript.

## Logging

```typescript
host.log.info(message: string): void
host.log.warn(message: string): void
host.log.error(message: string): void
```

Logs are prefixed with `[plugin:<id>]` and written to the app's log output.

**Example:**

```javascript
ctx.host.log.info("Fetching usage data...")
ctx.host.log.warn("Token expires soon")
ctx.host.log.error("API request failed: " + error.message)
```

## Filesystem

```typescript
host.fs.exists(path: string): boolean
host.fs.existsStrict(path: string): boolean  // False only for missing paths; throws on other metadata errors
host.fs.readText(path: string): string   // Throws on error
host.fs.writeText(path: string, content: string): void  // Throws on error
host.fs.writeTextIfUnchanged(path: string, content: string, expectedSha256: string): boolean  // Throws on I/O error
host.fs.listDir(path: string): string[]  // Throws if directory cannot be opened; per-entry errors are silently skipped
```

### Path Expansion

- `~` expands to the user's home directory
- `~/foo` expands under the user's home directory on macOS and Windows

### Error Handling

Use `existsStrict` before choosing between credential sources. It returns `false` only when the path is missing beneath a readable directory. An existing non-directory parent or a broken symbolic link at the path or any parent is an error, including on Windows where the original lookup may report a missing path. Permission failures and other metadata errors throw a fixed message without the local path; they must not select an older login. The existing `exists` keeps its previous behavior, including returning `false` on metadata errors.

Filesystem reads and writes throw on I/O errors. Always wrap them in try/catch:

```javascript
try {
  const content = ctx.host.fs.readText("~/.config/myapp/settings.json")
  const settings = JSON.parse(content)
} catch (e) {
  ctx.host.log.error("Failed to read settings: " + String(e))
  throw "Failed to read settings. Check your config."
}
```

Use `writeTextIfUnchanged` when updating a credential file owned by another process. Pass the SHA-256 of the exact text previously read. It returns `false` without writing when the file digest no longer matches at the final check. On Windows, in-place writers are blocked during replacement and transient sharing violations are retried. It cannot provide atomic coordination with a separate program that replaces the whole file path.

### Directory Listing

Use `listDir` to inspect immediate child names under a directory:

```javascript
let entries = []
try {
  entries = ctx.host.fs.listDir("~/Library/Application Support/JetBrains")
} catch {
  entries = []
}
```

**Example: Persisting plugin state**

```javascript
const statePath = ctx.app.pluginDataDir + "/state.json"

// Read state
let state = { counter: 0 }
if (ctx.host.fs.exists(statePath)) {
  try {
    state = JSON.parse(ctx.host.fs.readText(statePath))
  } catch {
    // Use default state
  }
}

// Update and save state
state.counter++
ctx.host.fs.writeText(statePath, JSON.stringify(state, null, 2))
```

## Crypto

```typescript
host.crypto.decryptAes256Gcm(envelope: string, keyB64: string): string  // Throws on error
host.crypto.encryptAes256Gcm(plaintext: string, keyB64: string): string // Throws on error
host.crypto.sha256Hex(text: string): string                    // Lowercase hex digest
host.crypto.hmacSha256Hex(key: string, message: string, keyIsHex: boolean): string // Lowercase hex digest
```

AES-256-GCM helpers for plugins that need to read or write locally encrypted auth/config blobs.
For signed API requests, `hmacSha256Hex` reads a UTF-8 key when `keyIsHex` is `false` and a hexadecimal key when it is `true`. Use the hexadecimal form for a key returned by a previous HMAC call.

### Envelope Format

- `iv_b64:tag_b64:ciphertext_b64`
- `keyB64` must be a base64-encoded 32-byte AES-256 key
- Both helpers operate on UTF-8 plaintext strings

### Example

```javascript
const keyB64 = ctx.host.fs.readText("~/.factory/auth.v2.key").trim()
const encrypted = ctx.host.fs.readText("~/.factory/auth.v2.file")
const rawJson = ctx.host.crypto.decryptAes256Gcm(encrypted, keyB64)
const auth = JSON.parse(rawJson)

auth.access_token = "new-token"
const nextEnvelope = ctx.host.crypto.encryptAes256Gcm(JSON.stringify(auth, null, 2), keyB64)
ctx.host.fs.writeText("~/.factory/auth.v2.file", nextEnvelope)
```

## Environment

```typescript
host.env.get(name: string): string | null
```

Reads an environment variable by name.

### Behavior

- Returns variable value as string when set
- Returns `null` when missing
- Variable must be whitelisted first in `src-tauri/src/plugin_engine/host_api.rs`
- Resolution order: current process env first, then a login+interactive shell lookup (macOS)
- Values may be cached for the app session; restart OpenUsageCN after changing shell config
- New-provider credentials are scoped to their declaring plugin: `CLAUDE_PLATFORM_COOKIE` / `CLAUDE_PLATFORM_ORGANIZATION_ID`, `LITELLM_BASE_URL` / `LITELLM_API_KEY`, `SILICONFLOW_API_KEY` / `SILICONFLOW_REGION`, `WORKBUDDY_COOKIE` / `WORKBUDDY_USER_AGENT`, and `TRAE_CN_COOKIE`. Muse has no environment-token input.
- `XDG_DATA_HOME` and `OPENCODE_DB` are available only to the OpenCode Go plugin for locating its existing CLI store

### Example

```javascript
const codexHome = ctx.host.env.get("CODEX_HOME")
const defaultAuthPath = ctx.app.platform === "windows"
  ? "~/.codex/auth.json"
  : "~/.config/codex/auth.json"
const authPath = codexHome
  ? codexHome.replace(/\/+$/, "") + "/auth.json"
  : defaultAuthPath
```

## Provider Config

```typescript
host.config.get(name: string): string | boolean | null
host.config.all(): Record<string, string | boolean>
```

Reads values saved from the plugin's connection fields. A plugin declares those fields in `plugin.json` under `config.fields`.

### Behavior

- `secret` and `text` fields return a string or `null`
- `select` fields return a valid option value
- `toggle` fields return a boolean
- Missing `toggle` values return `false`
- Missing `select` values return the field default, or the first option
- Plugins without config still get `host.config`; `get()` returns `null` and `all()` returns `{}`

The configuration view separates saved field IDs from confirmed environment sources. Secret sources expose presence and the variable name only. Public region sources may expose a valid declared option; an unsupported environment region does not select a valid region. This metadata does not change `host.config` or the plugin's credential priority. Saved values for hidden fields are retained. A connection-page check uses a fresh probe batch and is independent of the provider enable switch.

If an environment lookup fails, the view keeps saved configuration and confirmed sources. It includes a friendly `environmentError` and the names that could not be checked in `environmentUnresolved`; the form shows the warning and stays editable. Unknown sources are not reported as missing or added to confirmed sources, including credentials whose environment region could not be checked. An automatic region whose source is unknown requires an explicit selection.

`required` defaults to `false` and applies only to `secret` and `text` fields. The form checks visible required fields against new input, saved values, or confirmed environment sources before submitting. It does not change the values returned by `host.config`.

The six new providers (`claude-platform`, `workbuddy`, `trae-cn`, `litellm`, `siliconflow`, `muse`) freeze their declared configuration and environment sources for each probe. Publication rechecks those sources. Their cached results carry a source fingerprint and cannot be reused after a connection changes; switching a connection clears only that provider's old data and pending verification. Shell environment changes still require restarting the app as described above.

Muse uses native `start_muse_login`, `poll_muse_login({ loginId })`, and `cancel_muse_login({ loginId })` commands. Only user code, trusted Meta verification URL, timing, session ID and status reach the frontend. A verified device grant conditionally replaces the unchanged Muse connection; cancellation, expiry, another session or a configuration change prevents saving. Model API keys returned by Meta are ignored. Tokens are saved privately in `providers.json`, not to an existing tool's credentials. Muse has no manual token form.

### Example

```javascript
const configured = ctx.host.config.get("apiKey")
const apiKey = typeof configured === "string" && configured.trim()
  ? configured.trim()
  : ctx.host.env.get("MY_PROVIDER_API_KEY")

if (!apiKey) {
  throw "API key required. Add it in Settings or set MY_PROVIDER_API_KEY."
}
```

## HTTP

```typescript
host.http.normalizeHttpsBaseUrl(raw: string): string | null
host.http.normalizeConfiguredBaseUrl(raw: string): string | null

host.http.request({
  method?: string,           // Default: "GET"
  url: string,
  headers?: Record<string, string>,
  bodyText?: string,
  timeoutMs?: number         // Default: 10000
}): {
  status: number,
  headers: Record<string, string>,
  bodyText: string
}
```

### Behavior

- **Configured gateways**: `normalizeConfiguredBaseUrl` accepts HTTPS, or HTTP for explicit loopback/private/link-local addresses and `localhost`/`.localhost`/`.local` hosts. It rejects credentials, queries, fragments, control characters and backslashes. It preserves the configured path; public cleartext HTTP is rejected. LiteLLM uses this method for its user-provided gateway.
- **Base URL validation**: `normalizeHttpsBaseUrl` returns a normalized HTTPS base URL without trailing slashes, or `null` for invalid URLs, embedded credentials, query parameters, or fragments. It does not restrict which valid HTTPS host a plugin may use.
- **No redirects**: The HTTP client does not follow redirects (policy: none)
- **Throws on network errors**: Connection failures, DNS errors, and timeouts throw
- **No domain allowlist**: Any URL is allowed (for now)

### Example: GET request

```javascript
let resp
try {
  resp = ctx.host.http.request({
    method: "GET",
    url: "https://api.example.com/usage",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/json",
    },
    timeoutMs: 5000,
  })
} catch (e) {
  throw "Network error. Check your connection."
}

if (resp.status !== 200) {
  throw "Request failed (HTTP " + resp.status + "). Try again later."
}

const data = JSON.parse(resp.bodyText)
```

### Example: POST request with JSON body

```javascript
const resp = ctx.host.http.request({
  method: "POST",
  url: "https://api.example.com/refresh",
  headers: {
    "Content-Type": "application/json",
  },
  bodyText: JSON.stringify({ refresh_token: token }),
  timeoutMs: 10000,
})
```

## Keychain (macOS only)

```typescript
host.keychain.readGenericPassword(service: string, account?: string): string
```

Reads a generic password from the macOS Keychain. Pass `account` when the service stores multiple accounts and the plugin must avoid a service-wide match.

### Behavior

- **macOS only**: Throws on other platforms
- **Bounded reads and writes**: Keychain operations use the remaining probe budget, capped at ten seconds. Timed-out subprocesses are stopped and reaped.
- **No background authorization prompts**: Before reading, the host checks the existing item's access rules without reading its password. It runs `/usr/bin/security` only when those rules already allow that accessor without a prompt. The host does not change access rules.
- **Shared reads**: Concurrent reads of the same service/account share one operation. A caller timing out does not cancel another caller's read.
- **Distinct failures**: Errors start with `missing:`, `denied:`, `locked:`, `timedOut:` or `failed:`. A rejected or locked item is not reported as missing. Raw system output is not included.
- **Denied access**: After a subprocess reports denial, later background attempts for that item stay blocked until restart. Restore access before restarting.
- **Write preflight**: Background writes first require an existing authorized item and preserve its selected service and account. If the item is missing at this check, log in through the owning tool. The host requests no account or access-rule changes.
- **Concurrent deletion limitation**: The check and `/usr/bin/security add-generic-password -U` are not atomic. If another process deletes the item between them, the command can recreate it under the selected service and account with the system's creation defaults. This API does not guarantee update-only writes. Prefer restoring a missing login through its owning tool.
- **Optional account scope**: When `account` is set, lookup uses both service and account

### Example

Only a confirmed missing file selects Keychain. Metadata, file-read, JSON parsing and Keychain errors stop the attempt; they do not select another credential source.

```javascript
let credentials = null
const credentialsPath = "~/.myapp/credentials.json"

try {
  const rawCredentials = ctx.host.fs.existsStrict(credentialsPath)
    ? ctx.host.fs.readText(credentialsPath)
    : ctx.host.keychain.readGenericPassword("MyApp-credentials")
  credentials = JSON.parse(rawCredentials)
} catch {
  ctx.host.log.error("Credentials could not be loaded.")
  throw "Credentials could not be loaded. Check file access or sign in again."
}
```

Kiro alone can read `KIRO_DATA_DIR` and `XDG_DATA_HOME` to locate its CLI database. It checks the chosen sign-in again before publishing and does not write that database.

## SQLite

All SQLite methods treat `dbPath` as a database filename. A leading `-` is protected with a relative-path prefix, and SQL is sent through stdin rather than command-line arguments. This also works with older SQLite CLIs that do not support `--`.

### Query (Read-Only)

```typescript
host.sqlite.query(dbPath: string, sql: string): string
host.sqlite.queryReadOnly(dbPath: string, sql: string): string
```

Executes a read-only SQL query against a SQLite database.

**Behavior:**

- **Read-only**: Both query methods open with `-readonly`. `query` keeps the existing WAL-visible primary read and immutable fallback. `queryReadOnly` fails directly without an immutable fallback; use it for sign-in databases so stale WAL-free credentials are never substituted.
- **Bounded execution**: Each call has at most ten seconds, further limited by the probe deadline. Primary and fallback share that budget; stdin, process exit and inherited output pipes cannot extend it. Each output stream is capped at 8 MiB. Errors use fixed messages and omit SQL, database contents and stderr.
- **Returns JSON string**: Result is a JSON array of row objects (must `JSON.parse()`)
- **Dot-commands blocked**: Commands like `.schema`, `.tables` are rejected
- **Throws on errors**: Invalid SQL, missing database, etc.

**Example:**

```javascript
const dbPath = "~/Library/Application Support/MyApp/state.db"
const sql = "SELECT key, value FROM settings WHERE key = 'token'"

let rows
try {
  const json = ctx.host.sqlite.query(dbPath, sql)
  rows = JSON.parse(json)
} catch (e) {
  ctx.host.log.error("SQLite query failed: " + String(e))
  throw "DB error. Check your data source."
}

if (rows.length === 0) {
  throw "Not configured. Update your settings."
}

const token = rows[0].value
```

### Exec (Read-Write)

```typescript
host.sqlite.exec(dbPath: string, sql: string): void
```

Executes a write SQL statement against a SQLite database.

**Behavior:**

- **Read-write**: Database is opened with full write access
- **Returns nothing**: Use for INSERT, UPDATE, DELETE, or other write operations
- **Dot-commands blocked**: Commands like `.schema`, `.tables` are rejected
- **Throws on errors**: Invalid SQL, missing database, permission denied, etc.

**Example:**

```javascript
const dbPath = "~/Library/Application Support/MyApp/state.db"

// Escape single quotes in value for SQL safety
const escaped = newToken.replace(/'/g, "''")
const sql = "INSERT OR REPLACE INTO settings (key, value) VALUES ('token', '" + escaped + "')"

try {
  ctx.host.sqlite.exec(dbPath, sql)
} catch (e) {
  ctx.host.log.error("SQLite write failed: " + String(e))
  throw "Failed to save token."
}
```

**Warning:** Be careful with SQL injection. Always escape user-provided values.

## Execution Timing

`probe(ctx)` is called when:

- The app loads
- The user clicks Refresh (per-provider retry button)
- The auto-update timer fires (configurable: 5/15/30/60 minutes)
- A reported `progress.resetsAt` boundary passes, after a short delay, when that targeted refresh would happen before the next auto-update timer

Reset-boundary refreshes only probe the provider that reported the boundary. A boundary is handled once per app session. Providers that are already loading or inside the automatic failure backoff are skipped. The user can still click Refresh to retry immediately.

Any token refresh logic (e.g., OAuth refresh) must run inside `probe(ctx)` at those times.

Bundled Codex and Claude keep local log history in `probeHistory(ctx, connectionTarget?)` instead.
That export is invoked only by an explicit **Load Local History** or **Refresh Local History**
request in the detail page. It runs in a separate sandbox and cannot update quota freshness,
notifications, account quota snapshots, or the Local HTTP cache. Claude receives the selected local
connection and its credential generation; it does not renew credentials during history collection.

## Line Builders

Helper functions for creating output lines. All builders use an options object pattern.

### `ctx.line.text(opts)`

Creates a text line (label/value pair).

```typescript
ctx.line.text({
  label: string,      // Required: label shown on the left
  value: string,      // Required: value shown on the right
  color?: string,     // Optional: hex color for value text
  subtitle?: string   // Optional: smaller text below the line
}): MetricLine
```

**Example:**

```javascript
ctx.line.text({ label: "Account", value: "user@example.com" })
ctx.line.text({ label: "Status", value: "Active", color: "#22c55e", subtitle: "Since Jan 2024" })
```

### `ctx.line.progress(opts)`

Creates a progress bar line.

```typescript
ctx.line.progress({
  label: string,                    // Required: label shown on the left
  used: number,                     // Required: amount used (>= 0)
  limit: number,                    // Required: limit (> 0)
  format: {                         // Required: formatting rules
    kind: "percent" | "dollars" | "count",
    suffix?: string                 // Required when kind="count" (e.g. "credits")
  },
  limitResourceKey?: string,        // Stable manifest key when the UI label is dynamic
  resetsAt?: string | null,         // Optional: ISO timestamp for when usage resets
  periodDurationMs?: number,        // Optional: period length in ms for pace tracking
  color?: string,                   // Optional: hex color for progress bar
}): MetricLine
```

Notes:

- `used` may exceed `limit` (overages).
- For `format.kind: "percent"`, `limit` must be `100`.
- Prefer setting `resetsAt` (via `ctx.util.toIso(...)`) instead of putting reset info in other lines.
- `periodDurationMs`: when provided with `resetsAt`, enables pace visuals (Dot Pacing status + in-bar pace marker) and projected-rate messaging.
- To expose this value through `/v1/limits`, add a stable `limitResource` declaration to the matching progress line in `plugin.json`. If its runtime label can change, also pass the same key as `limitResourceKey`. Do not expose formatted text by parsing it.

**Example:**

```javascript
ctx.line.progress({ label: "Usage", used: 42, limit: 100, format: { kind: "percent" } })
ctx.line.progress({ label: "Spend", used: 12.34, limit: 100, format: { kind: "dollars" } })
ctx.line.progress({
  label: "Session",
  used: 75,
  limit: 100,
  format: { kind: "percent" },
  resetsAt: ctx.util.toIso("2026-02-01T00:00:00Z"),
})
```

### `ctx.line.badge(opts)`

Creates a badge line (status indicator).

```typescript
ctx.line.badge({
  label: string,      // Required: label shown on the left
  text: string,       // Required: badge text
  color?: string,     // Optional: hex color for badge border/text
  subtitle?: string   // Optional: smaller text below the line
}): MetricLine
```

**Example:**

```javascript
ctx.line.badge({ label: "Plan", text: "Pro", color: "#000000" })
ctx.line.badge({ label: "Status", text: "Connected", color: "#22c55e" })
```

### `ctx.line.barChart(opts)`

Creates a compact vertical bar chart line for usage history.

```typescript
ctx.line.barChart({
  label: string,                    // Required: chart label
  points: Array<{
    label: string,                  // Required: point label, e.g. day
    value: number,                  // Required: non-negative chart value
    valueLabel?: string             // Optional: displayed value, e.g. "1.2M tokens"
  }>,
  note?: string,                    // Optional: small muted note below chart
  color?: string,                   // Optional: hex color for bars
}): MetricLine
```

**Example:**

```javascript
ctx.line.barChart({
  label: "Usage Trend",
  points: [
    { label: "2/1", value: 1200, valueLabel: "1.2K tokens" },
    { label: "2/2", value: 2400, valueLabel: "2.4K tokens" },
  ],
  note: "Estimated from local logs",
})
```

## Formatters

Helper functions for formatting values.

### `ctx.fmt.planLabel(value)`

Capitalizes a plan name string.

```javascript
ctx.fmt.planLabel("pro")        // "Pro"
ctx.fmt.planLabel("team_plan")  // "Team_plan"
```

### `ctx.fmt.resetIn(seconds)`

Formats seconds until reset as human-readable duration.

```javascript
ctx.fmt.resetIn(180000)  // "2d 2h"
ctx.fmt.resetIn(7200)    // "2h 0m"
ctx.fmt.resetIn(300)     // "5m"
ctx.fmt.resetIn(30)      // "<1m"
```

### `ctx.fmt.dollars(cents)`

Converts cents to dollars.

```javascript
ctx.fmt.dollars(1234)  // 12.34
ctx.fmt.dollars(500)   // 5
```

### `ctx.fmt.date(unixMs)`

Formats Unix milliseconds as short date.

```javascript
ctx.fmt.date(1704067200000)  // "Jan 1"
```

## Utilities

### `ctx.util.toIso(value)`

Normalizes a timestamp into an ISO string (or returns `null` if the input can't be parsed).

Accepts common inputs like:

- ISO strings (with or without timezone; timezone-less is treated as UTC)
- Unix seconds / milliseconds (number or numeric string)
- `Date` objects

**Example:**

```javascript
ctx.line.progress({
  label: "Weekly",
  used: 24,
  limit: 100,
  format: { kind: "percent" },
  resetsAt: ctx.util.toIso(data.resets_at),
})
```

## ccusage (Token Usage)

> macOS only for bundled launch plugins. The Windows MVP does not run `ccusage`; plugins must omit these local token metrics on Windows.

```typescript
host.ccusage.query(opts: {
  provider?: "claude" | "codex", // Optional; defaults to plugin id, then "claude"
  since?: string,                // Start date (YYYYMMDD or YYYY-MM-DD)
  until?: string,                // End date (YYYYMMDD or YYYY-MM-DD)
  homePath?: string,             // Provider home override (CLAUDE_CONFIG_DIR or CODEX_HOME)
  claudePath?: string,           // Legacy Claude-only override (deprecated; use homePath)
}):
  | { status: "ok", data: { daily: DailyUsage[] } }
  | { status: "no_runner" }
  | { status: "runner_failed" }
```

Queries local token usage via provider-focused ccusage commands:

- Claude: [`ccusage claude daily`](https://github.com/ryoppippi/ccusage)
- Codex: [`ccusage codex daily`](https://github.com/ryoppippi/ccusage)

Returns a status envelope:

- `ok`: query succeeded, usage data is in `data.daily`
- `no_runner`: no package runner (`bunx/pnpm/yarn/npm/npx`) was found
- `runner_failed`: at least one runner was available but all attempts failed

### Behavior

- **Runtime runners**: Executes pinned `ccusage@20.0.20` via fallback chain `bunx -> pnpm dlx -> yarn dlx -> npm exec -> npx`
- **Bounded work**: Each runner availability check (`--version`) has at most 2 seconds, and each execution has at most 15 seconds. Discovery, execution, and fallbacks share the history sandbox's 30-second budget; timed-out child processes are stopped and reaped.
- **Provider-aware**: Resolves provider from `opts.provider` or plugin id (`claude`/`codex`)
- **Focused commands**: Uses `ccusage claude daily` or `ccusage codex daily`; it intentionally does not use `ccusage daily` because that aggregates all detected agents
- **Legacy fallback**: If `ccusage@20.0.20` cannot run through the package manager release-age policy, retries with release-age-safe `ccusage@18.0.11` for Claude or `@ccusage/codex@18.0.11` for Codex
- **No provider API calls**: Usage is computed from local JSONL session files; the host does not call Claude/Codex (or other provider) APIs, but package runners may contact a package registry to download the `ccusage` CLI if it is not already available locally
- **Graceful degradation**: returns `no_runner` when no runner exists, `runner_failed` when execution fails
- **Pricing**: Uses ccusage's built-in LiteLLM pricing data

The bundled local history views fix `since` and `until` from the same local date, covering today and
the preceding 30 calendar days (31 days inclusive). History failures are shown in the detail section
and leave live quota available. The CLI does not request this optional history.

### DailyUsage

The host normalizes only the top-level shape to `{ daily: [...] }`. Inner day fields come from the selected CLI and may differ by provider/version.

Commonly observed fields include:

| Property             | Type            | Notes |
| -------------------- | --------------- | ----- |
| `date`               | `string`        | Date label from CLI output (provider/locale-dependent) |
| `inputTokens`        | `number`        | Present in Claude and Codex |
| `outputTokens`       | `number`        | Present in Claude and Codex |
| `cacheCreationTokens`| `number`        | Claude field |
| `cacheReadTokens`    | `number`        | Claude field |
| `cachedInputTokens`  | `number`        | Codex field |
| `totalTokens`        | `number`        | Present in current Claude/Codex outputs |
| `totalCost`          | `number \| null`| Claude cost field |
| `costUSD`            | `number`        | Codex cost field |

### Example

```javascript
var result = ctx.host.ccusage.query({ provider: "codex", since: "20260101" })
if (result.status === "ok") {
  for (var i = 0; i < result.data.daily.length; i++) {
    var day = result.data.daily[i]
    var cost = day.totalCost != null ? day.totalCost : day.costUSD
    ctx.host.log.info(day.date + ": " + (day.totalTokens || 0) + " tokens, $" + (cost != null ? cost : "n/a"))
  }
} else if (result.status === "no_runner") {
  ctx.host.log.warn("ccusage unavailable: no package runner found")
}
```

## See Also

- [Plugin Schema](./schema.md) - Plugin structure, manifest format, and output schema


Muse connection commits emit native `provider:connection-committed` with `providerId` and the last real `previousBatchId`. Credential save, batch replacement and notification share the ownership lock. The global UI listener compares its monotonic batch order: old data/checks are invalidated even after the sheet closes, while newer successful results and newer pending work remain valid. Cancellation is an asynchronous command, and the earliest grant/device-session deadline is rechecked immediately before credential replacement, including Windows retries.
