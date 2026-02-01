# Plugin Schema

Plugin structure, manifest format, output schema, and lifecycle.

## Architecture Overview

```
User triggers refresh
       |
Tauri command `run_plugin_probes(pluginIds?)`
       |
For each enabled plugin:
  -> Create fresh QuickJS sandbox
  -> Inject host APIs (`ctx.host.*`)
  -> Evaluate plugin.js
  -> Call `probe(ctx)`
  -> Parse returned `{ lines: MetricLine[] }`
       |
Return `PluginOutput[]` to frontend
       |
UI renders via ProviderCard component
```

Key points:

- Each probe runs in **isolated QuickJS runtime** (no shared state between plugins or calls)
- Plugins are **synchronous or Promise-based** (unresolved promises timeout)
- **No background scheduler** - only runs on app load and when user clicks Refresh

## Plugin Directory Layout

```
plugins/<id>/
  plugin.json    <- manifest (required)
  plugin.js      <- entry script (required)
  icon.svg       <- plugin icon (required)
```

Bundled plugins live under `src-tauri/resources/bundled_plugins/<id>/`.

## Manifest Schema (`plugin.json`)

```json
{
  "schemaVersion": 1,
  "id": "my-provider",
  "name": "My Provider",
  "version": "0.0.1",
  "entry": "plugin.js",
  "icon": "icon.svg"
}
```

| Field           | Type   | Required | Description                                |
| --------------- | ------ | -------- | ------------------------------------------ |
| `schemaVersion` | number | Yes      | Always `1`                                 |
| `id`            | string | Yes      | Unique identifier (kebab-case recommended) |
| `name`          | string | Yes      | Display name shown in UI                   |
| `version`       | string | Yes      | Semver version                             |
| `entry`         | string | Yes      | Relative path to JS entry file             |
| `icon`          | string | Yes      | Relative path to SVG icon file             |

Validation rules:

- `entry` must be relative (not absolute)
- `entry` must exist within the plugin directory
- `id` must match `globalThis.__openusage_plugin.id`
- `icon` must be relative and point to an SVG file (use `fill="currentColor"` for theme compatibility)

## Entry Point Structure

Plugins must register themselves on the global object:

```javascript
globalThis.__openusage_plugin = {
  id: "my-provider",  // Must match manifest.id
  probe: function(ctx) { ... }
}
```

## Output Schema

`probe(ctx)` must return (or resolve to):

```javascript
{ lines: MetricLine[] }
```

### Line Types

```typescript
type MetricLine =
  | { type: "text"; label: string; value: string; color?: string }
  | { type: "progress"; label: string; value: number; max: number; unit?: "percent" | "dollars"; color?: string }
  | { type: "badge"; label: string; text: string; color?: string }
```

- `color`: optional hex string (e.g. `#22c55e`)
- `unit`: `"percent"` shows `X%`, `"dollars"` shows `$X.XX`

### Text Line

Simple label/value pair.

```javascript
{ type: "text", label: "Account", value: "user@example.com" }
```

### Progress Line

Shows a progress bar with optional formatting.

```javascript
{ type: "progress", label: "Usage", value: 42, max: 100, unit: "percent" }
// Renders: Usage [████████░░░░░░░░░░░░] 42%

{ type: "progress", label: "Spend", value: 12.34, max: 100, unit: "dollars" }
// Renders: Spend [█░░░░░░░░░░░░░░░░░░░] $12.34
```

### Badge Line

Status indicator with colored background.

```javascript
{ type: "badge", label: "Status", text: "Connected", color: "#22c55e" }
```

## Error Handling

| Condition                  | Result                                        |
| -------------------------- | --------------------------------------------- |
| Plugin throws              | Error badge returned                          |
| Promise rejects            | Error badge                                   |
| Promise never resolves     | Error badge (timeout)                         |
| Invalid line type          | Error badge                                   |
| Missing `lines` array      | Error badge                                   |
| Non-finite progress values | Coerced to `value: -1, max: 0` (UI shows N/A) |

## Minimal Example

A complete, working plugin that fetches data and displays all three line types.

**`plugin.json`:**

```json
{
  "schemaVersion": 1,
  "id": "minimal",
  "name": "Minimal Example",
  "version": "0.0.1",
  "entry": "plugin.js",
  "icon": "icon.svg"
}
```

**`plugin.js`:**

```javascript
(function () {
  globalThis.__openusage_plugin = {
    id: "minimal",
    probe: function (ctx) {
      let resp
      try {
        resp = ctx.host.http.request({
          method: "GET",
          url: "https://httpbin.org/json",
          timeoutMs: 5000,
        })
      } catch (e) {
        return { lines: [{ type: "badge", label: "Error", text: "Request failed", color: "#ef4444" }] }
      }

      if (resp.status !== 200) {
        return { lines: [{ type: "badge", label: "Error", text: "HTTP " + resp.status, color: "#ef4444" }] }
      }

      let data
      try {
        data = JSON.parse(resp.bodyText)
      } catch {
        return { lines: [{ type: "badge", label: "Error", text: "Invalid JSON", color: "#ef4444" }] }
      }

      return {
        lines: [
          { type: "badge", label: "Status", text: "Connected", color: "#22c55e" },
          { type: "progress", label: "Usage", value: 42, max: 100, unit: "percent" },
          { type: "text", label: "Fetched at", value: ctx.nowIso },
        ],
      }
    },
  }
})()
```

## Best Practices

- Wrap all host API calls in try/catch
- Return user-friendly error badges (not raw exception messages)
- Use `ctx.app.pluginDataDir` for plugin-specific state/config
- Keep probes fast (users wait on refresh)
- Validate API responses before accessing nested fields

## See Also

- [Host API Reference](./api.md) - Full documentation of `ctx.host.*` APIs
