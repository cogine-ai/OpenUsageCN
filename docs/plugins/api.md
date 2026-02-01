# Host API Reference

This document describes the host APIs available to plugins via the `ctx` object passed to `probe(ctx)`.

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
host.fs.readText(path: string): string   // Throws on error
host.fs.writeText(path: string, content: string): void  // Throws on error
```

### Path Expansion

- `~` expands to the user's home directory
- `~/foo` expands to `$HOME/foo`

### Error Handling

Both `readText` and `writeText` throw on errors. Always wrap in try/catch:

```javascript
try {
  const content = ctx.host.fs.readText("~/.config/myapp/settings.json")
  const settings = JSON.parse(content)
} catch (e) {
  ctx.host.log.error("Failed to read settings: " + e.message)
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

## HTTP

```typescript
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
  return { lines: [{ type: "badge", label: "Error", text: "Network error", color: "#ef4444" }] }
}

if (resp.status !== 200) {
  return { lines: [{ type: "badge", label: "Error", text: "HTTP " + resp.status, color: "#ef4444" }] }
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
host.keychain.readGenericPassword(service: string): string
```

Reads a generic password from the macOS Keychain.

### Behavior

- **macOS only**: Throws on other platforms
- **Throws if not found**: Returns the password string if found, throws otherwise

### Example

```javascript
let credentials = null

// Try file first, fall back to keychain
if (ctx.host.fs.exists("~/.myapp/credentials.json")) {
  credentials = JSON.parse(ctx.host.fs.readText("~/.myapp/credentials.json"))
} else {
  try {
    const keychainValue = ctx.host.keychain.readGenericPassword("MyApp-credentials")
    credentials = JSON.parse(keychainValue)
  } catch {
    return { lines: [{ type: "badge", label: "Status", text: "Login required", color: "#f59e0b" }] }
  }
}
```

## SQLite

```typescript
host.sqlite.query(dbPath: string, sql: string): string
```

Executes a read-only SQL query against a SQLite database.

### Behavior

- **Read-only**: Database is opened with `-readonly` flag
- **Returns JSON string**: Result is a JSON array of row objects (must `JSON.parse()`)
- **Dot-commands blocked**: Commands like `.schema`, `.tables` are rejected
- **Throws on errors**: Invalid SQL, missing database, etc.

### Example

```javascript
const dbPath = "~/Library/Application Support/MyApp/state.db"
const sql = "SELECT key, value FROM settings WHERE key = 'token'"

let rows
try {
  const json = ctx.host.sqlite.query(dbPath, sql)
  rows = JSON.parse(json)
} catch (e) {
  ctx.host.log.error("SQLite query failed: " + e.message)
  return { lines: [{ type: "badge", label: "Error", text: "DB error", color: "#ef4444" }] }
}

if (rows.length === 0) {
  return { lines: [{ type: "badge", label: "Status", text: "Not configured", color: "#f59e0b" }] }
}

const token = rows[0].value
```

## Execution Timing

There is no background scheduler. `probe(ctx)` is only called when:

- The app loads
- The user clicks Refresh

Any token refresh logic (e.g., OAuth refresh) must run inside `probe(ctx)` at those times.

## See Also

- [Plugin Schema](./schema.md) - Plugin structure, manifest format, and output schema
