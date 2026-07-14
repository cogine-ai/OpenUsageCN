# Local HTTP API

OpenUsageCN exposes a read-only HTTP API on the loopback interface so other local apps can consume the same usage data shown in the menu bar.

**Base URL:** `http://127.0.0.1:6736`

The server starts automatically with the app. If the port is already in use, the API is disabled for that session and Settings shows the bind failure.

## Routes

### `GET /health`

Returns local API service and cache readiness information.

- **200 OK** — The local HTTP service is running. Cached usage data may still be empty while OpenUsageCN waits for the first successful refresh.

Example:

```json
{
  "status": "ok",
  "apiVersion": "v1",
  "version": "0.6.28",
  "service": {
    "state": "running",
    "bind": "127.0.0.1:6736",
    "startedAt": "2026-06-16T10:00:00Z"
  },
  "providers": {
    "known": 18,
    "enabled": 3,
    "cached": 2
  },
  "cache": {
    "ready": true,
    "lastSuccessfulFetchAt": "2026-06-16T11:30:00Z"
  }
}
```

`providers.cached` and `cache.ready` only count enabled providers that would appear in `GET /v1/usage`. `cache.ready` is `false` on a clean launch until at least one enabled provider has refreshed successfully. That is not a service failure.

### `GET /v1/usage`

Returns an array of cached usage snapshots for all **enabled** providers, ordered by your plugin settings.

- **200 OK** — JSON array (may be empty `[]` if no cached data exists yet).

### `GET /v1/usage/:providerId`

Returns a single cached usage snapshot for the given provider.

- **200 OK** — JSON object with cached snapshot.
- **204 No Content** — Provider is known but has no cached snapshot yet.
- **404 Not Found** — Provider ID is unknown.

### `GET /v1/limits`

Returns the stable `openusage.limits.v1` machine contract for all enabled providers. The first version exports numeric progress resources declared by each plugin; standalone balances and formatted text are not exported. UI labels, colors, badges, and charts are also excluded.

- **200 OK** — A limits envelope. `providers` may be empty before the first successful refresh.

### `GET /v1/limits/:providerId`

Returns the same envelope scoped to one provider, including providers disabled in Settings.

- **200 OK** — A scoped limits envelope. A refresh error can be returned even when no snapshot exists.
- **204 No Content** — Provider is known but has neither a successful snapshot nor a recorded refresh error.
- **404 Not Found** — Provider ID is unknown.

### Unsupported methods

Any method other than `GET` or `OPTIONS` on the above routes returns **405 Method Not Allowed**.

Unknown routes return **404 Not Found**.

## Usage Response Shape

```json
{
  "providerId": "claude",
  "displayName": "Claude",
  "plan": "Team 5x",
  "lines": [
    {
      "type": "progress",
      "label": "Session",
      "used": 42.0,
      "limit": 100.0,
      "format": { "kind": "percent" },
      "resetsAt": "2026-03-26T13:00:00.161Z",
      "periodDurationMs": 18000000,
      "color": null
    },
    {
      "type": "text",
      "label": "Today",
      "value": "$5.17 \u00b7 9.2M tokens",
      "color": null,
      "subtitle": null
    },
    {
      "type": "barChart",
      "label": "Usage Trend",
      "points": [
        { "label": "3/25", "value": 1200000.0, "valueLabel": "1.2M tokens" },
        { "label": "3/26", "value": 2400000.0, "valueLabel": "2.4M tokens" }
      ],
      "note": "Estimated from local logs",
      "color": null
    }
  ],
  "fetchedAt": "2026-03-26T11:16:29Z"
}
```

The `lines` array uses the same metric line types as the internal plugin output: `progress`, `text`, `badge`, and `barChart`.

`fetchedAt` is an ISO 8601 timestamp indicating when the snapshot was last successfully fetched.

`iconUrl` is intentionally omitted from the API response to keep payloads small.

## Limits Response Shape

```json
{
  "schema": "openusage.limits.v1",
  "generatedAt": "2026-07-14T02:04:00Z",
  "providers": {
    "codex": {
      "displayName": "Codex",
      "plan": "Plus",
      "fetchedAt": "2026-07-14T02:00:00Z",
      "expiresAt": "2026-07-14T02:05:00Z",
      "stale": false,
      "resources": {
        "session": {
          "kind": "consumption",
          "unit": "percent",
          "used": 34.0,
          "limit": 100.0,
          "remaining": 66.0,
          "utilization": 0.34,
          "resetsAt": "2026-07-14T09:00:00Z",
          "windowSeconds": 18000.0
        }
      }
    }
  },
  "errors": []
}
```

Resource keys such as `session` and `weekly` are stable identifiers declared by each plugin. Units are stable values such as `percent`, `usd`, `tokens`, `requests`, or `credits`. `expiresAt` is five minutes after the successful fetch; `stale` becomes `true` at that point.

`used`, `available`, `limit`, `remaining`, and `utilization` are optional by contract so bounded consumption and unbounded balances can share the same schema. Current progress resources report `used`, `limit`, `remaining`, and `utilization`; values above `1` represent usage over the limit. Consumers must not infer missing fields.

The resource key is stable, but its `unit` can follow the live plan or metric. Consumers should read `unit` from every response instead of assuming one permanent unit for a key.

If a refresh fails, the last successful provider snapshot remains available and a redacted entry may appear in `errors`. Consumers should use numeric fields instead of parsing text from `/v1/usage`.

### Current Resource Keys

These identifiers are the stable keys currently exported by bundled plugins. New keys may be added without changing the schema.

| Provider | Resource keys |
|---|---|
| `alibaba-coding-plan` | `session`, `weekly`, `monthly` |
| `alibaba-token-plan` | `tokenQuota` |
| `amp` | `free` |
| `antigravity` | `geminiPro`, `geminiFlash`, `claude` |
| `bigmodel-cn` | `session`, `weekly`, `webSearches` |
| `claude` | `session`, `weekly`, `sonnet`, `claudeDesign`, `extraUsage` |
| `codex` | `session`, `weekly`, `spark`, `sparkWeekly`, `codeReview` |
| `copilot` | `premiumCredits`, `chat`, `completions` |
| `cursor` | `credits`, `totalUsage`, `requests`, `autoUsage`, `apiUsage`, `onDemand` |
| `devin` | `weekly`, `daily` |
| `factory` | `standard`, `premium` |
| `gemini` | `pro`, `flash`, `flashLite` |
| `grok` | `creditsUsed` |
| `jetbrains-ai-assistant` | `quota` |
| `kimi` | `session`, `weekly` |
| `kiro` | `credits`, `bonusCredits` |
| `minimax` | `session` |
| `openai-api` | `credits` |
| `opencode-go` | `session`, `weekly`, `monthly` |
| `opencode` | `session`, `weekly` |
| `openrouter` | `credits`, `keyLimit` |
| `perplexity` | `apiCredits` |
| `synthetic` | `fiveHour`, `mana`, `subscription`, `freeToolCalls`, `search` |
| `zai` | `session`, `weekly`, `webSearches` |

## Filtering and Caching Behavior

- The collection endpoint (`/v1/usage`) returns **enabled providers only**, in the order defined by your plugin settings.
- Only **successful** probe results are cached. A failed probe never overwrites a previous successful snapshot.
- The single-provider endpoint (`/v1/usage/:providerId`) works for any known provider, including disabled ones.
- The limits collection follows the same enabled-provider selection. `providers` is an object, so consumers must not rely on key order. Its single-provider route also works for disabled providers.
- Limits freshness is five minutes. The HTTP API never triggers a refresh; use the app or the [`openusage` CLI](cli.md) when fresh data is required.

## CORS

Responses include preflight headers:

```http
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

Browser requests only receive `Access-Control-Allow-Origin` when the `Origin` is a loopback source such as `http://localhost:3000`, `http://127.0.0.1:1420`, `http://[::1]:3000`, or an OpenUsageCN Tauri app origin. Public website origins do not receive this header, so browsers cannot read the response body from those pages.

`OPTIONS` requests return **204 No Content** with these headers for preflight support.

## Error Responses

Error responses use this shape:

```json
{
  "error": "provider_not_found"
}
```

Possible error codes: `provider_not_found`, `not_found`, `method_not_allowed`, `server_busy`, `forbidden_host`, `internal_error`.

`server_busy` returns **503 Service Unavailable** when the local API is already handling the maximum number of concurrent connections. Clients should back off and retry later.

Requests with a non-loopback `Host` header return **403 Forbidden**:

```json
{
  "error": "forbidden_host"
}
```

Accepted hosts are `127.0.0.1`, `127.0.0.1:6736`, `localhost`, `localhost:6736`, `[::1]`, and `[::1]:6736`.

## Settings Status

Settings separates two states:

- **Service status** — whether the local HTTP server is starting, running, or failed to bind the port.
- **Data status** — whether any successful provider snapshot is cached yet.

While the service is starting or data is not ready, Settings refreshes this status automatically.

If the service is running but `GET /v1/usage` returns `[]`, check `GET /health`. An empty usage array usually means there is no cached provider data yet, not that the API is down.

## Security

The API is read-only and binds only to loopback. It does not expose provider credentials. `/v1/usage` returns cached presentation data, while `/v1/limits` returns only explicitly exported numeric resources and freshness metadata.

OpenUsageCN rejects non-loopback `Host` headers and only grants browser CORS reads to loopback or app origins. This reduces DNS rebinding exposure from browser pages. Keep local integrations pointed at `http://127.0.0.1:6736` or `http://localhost:6736`.
