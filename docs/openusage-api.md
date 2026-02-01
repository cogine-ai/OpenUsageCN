# OpenUsage Plugin API

This document describes the JavaScript plugin API available today. Plugins run only when the app calls `run_plugin_probes` (on load and when the user clicks Refresh). There is no scheduler or background job system.

## Plugin layout

Each plugin is a folder with a manifest and entry script:

```
plugins/<id>/
  plugin.json
  plugin.js
```

Bundled defaults live under `src-tauri/resources/bundled_plugins/<id>/`.

### `plugin.json`

Minimal schema (current):

```json
{
  "schemaVersion": 1,
  "id": "codex",
  "name": "Codex",
  "version": "0.0.1",
  "entry": "plugin.js"
}
```

## Runtime model

Plugins are evaluated in a Rust-side QuickJS sandbox. Each plugin must set:

```js
globalThis.__openusage_plugin = { id: "plugin-id", probe }
```

`probe(ctx)` runs synchronously and must return (or resolve to):

```js
{ lines: MetricLine[] }
```

If a plugin throws or returns malformed output, the host will return a single `badge` line labeled "Error".

## Output schema

```ts
type MetricLine =
  | { type: "text"; label: string; value: string; color?: string }
  | { type: "progress"; label: string; value: number; max: number; unit?: "percent" | "dollars"; color?: string }
  | { type: "badge"; label: string; text: string; color?: string }
```

Notes:
- `color` is an optional hex string like `#000000` or `#22c55e`.
- Progress uses `value` and `max`; the UI computes the percent.
- `unit` controls value formatting: `"percent"` shows `X%`, `"dollars"` shows `$X.XX`. Without `unit`, shows `value` only.
- The UI is always two columns: label on the left, value on the right.

## Context object

`probe(ctx)` receives a context object injected by the host:

```ts
type ProbeContext = {
  nowIso: string
  app: {
    version: string
    platform: string
    appDataDir: string
    pluginDataDir: string
  }
  host: HostApi
}
```

## Host APIs

### Logging

```ts
host.log.info(message: string): void
host.log.warn(message: string): void
host.log.error(message: string): void
```

### Filesystem

```ts
host.fs.exists(path: string): boolean
host.fs.readText(path: string): string
host.fs.writeText(path: string, content: string): void
```

Notes:
- `~` is expanded to the user home directory.
- Errors throw and should be caught by the plugin.

### HTTP

```ts
host.http.request({
  method: string,
  url: string,
  headers?: Record<string, string>,
  bodyText?: string,
  timeoutMs?: number
}): {
  status: number,
  headers: Record<string, string>,
  bodyText: string
}
```

Notes:
- No domain allowlist currently enforced.
- Redirects are disabled in the host HTTP client.
- Invalid HTTP method or headers throw.

### Keychain (macOS)

```ts
host.keychain.readGenericPassword(service: string): string
```

Notes:
- Only available on macOS; other platforms throw.

### SQLite

```ts
host.sqlite.query(dbPath: string, sql: string): string
```

Notes:
- Executes `sqlite3 -readonly -json` and returns the raw JSON string.
- Dot-commands (e.g. `.schema`) are blocked.

## Execution timing

There is no background scheduler. `probe(ctx)` is only called when:
- the app loads, or
- the user triggers Refresh.

Any token refresh logic (e.g., OAuth refresh) runs inside `probe(ctx)` and only at those times.
