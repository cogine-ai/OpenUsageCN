# Synthetic

## Overview

- **Protocol:** REST (`GET /v2/quotas`)
- **URL:** `https://api.synthetic.new/v2/quotas`
- **Auth:** API key discovered from Pi, Factory/Droid, OpenCode, or `SYNTHETIC_API_KEY` env var
- **Quota:** Current weekly plan limit, with older response formats supported separately

## Authentication

The plugin searches multiple sources for a Synthetic API key, checking under the provider names `synthetic`, `synthetic.new`, and `syn`. The first key found wins.

### Credential Sources (checked in order)

**1. Pi auth.json** — `~/.pi/agent/auth.json`

```json
{
  "synthetic": {
    "type": "api_key",
    "key": "syn_..."
  }
}
```

The Pi agent directory can be overridden via the `PI_CODING_AGENT_DIR` environment variable (e.g. `PI_CODING_AGENT_DIR=~/custom/pi`).

**2. Pi models.json** — `~/.pi/agent/models.json`

For users who configured Synthetic as a custom provider in Pi:

```json
{
  "providers": {
    "synthetic": {
      "apiKey": "syn_..."
    }
  }
}
```

**3. Factory/Droid settings.json** — `~/.factory/settings.json`

For users who configured Synthetic as a custom model in Factory/Droid. The plugin scans the `customModels` array for any entry with a `baseUrl` containing `synthetic.new`:

```json
{
  "customModels": [
    {
      "baseUrl": "https://api.synthetic.new/openai/v1",
      "apiKey": "syn_...",
      "displayName": "Kimi K2.5 [Synthetic]"
    }
  ]
}
```

**4. OpenCode auth.json** — `~/.local/share/opencode/auth.json`

```json
{
  "synthetic": {
    "key": "syn_..."
  }
}
```

**5. Environment variable** — `SYNTHETIC_API_KEY`

Falls back to the `SYNTHETIC_API_KEY` environment variable if no file source contains a key.

The key is sent as `Authorization: Bearer <key>` to the quotas API.

## Data Source

### API Endpoint

```
GET https://api.synthetic.new/v2/quotas
Authorization: Bearer <api_key>
Accept: application/json
```

Quota checks do not count against subscription limits.

### Response

Current plans can return `planWeeklyLimit`, either at the response root or inside `data`:

```json
{
  "planWeeklyLimit": {
    "percentRemaining": 99.47981765714286,
    "nextRegenAt": "2026-11-07T00:30:00+08:00",
    "nextRegenPercent": 2
  },
  "search": { "hourly": { "limit": 250, "requests": 5 } }
}
```

`Weekly` is the primary quota for this format, exported as `planWeekly` with percent units.
`percentRemaining` and `nextRegenPercent` are percentage points: 0.5 means 0.5%, not 50%.
Weekly usage keeps fractional precision. The old Subscription, Rolling 5h and Mana Bar lanes are
not displayed alongside this new plan. Search remains independent. A present but invalid new plan
reports an error instead of reviving retired counters.

`Next Regen` shows the supplied instant in UTC, and `Regen Percent` shows the reported percentage.
These describe partial regeneration. Neither is a full reset, and neither sets `resetsAt` or starts
pace forecasts. Invalid optional regeneration metadata is marked unavailable while Weekly remains.

Older responses remain supported when `planWeeklyLimit` is absent:

```json
{
  "subscription": {
    "limit": 600,
    "requests": 0,
    "renewsAt": "2026-04-30T20:18:54.144Z"
  },
  "search": {
    "hourly": {
      "limit": 250,
      "requests": 0,
      "renewsAt": "2026-03-30T16:18:54.145Z"
    }
  },
  "weeklyTokenLimit": {
    "nextRegenAt": "2026-03-30T16:20:39.000Z",
    "percentRemaining": 100
  },
  "rollingFiveHourLimit": {
    "nextTickAt": "2026-03-30T15:30:29.000Z",
    "tickPercent": 0.05,
    "remaining": 600,
    "max": 600,
    "limited": false
  }
}
```

### Quota Systems

Older responses can contain two complementary rate limiting systems:

**Rolling 5-hour limit** — burst rate control:
- `remaining` / `max` requests in a rolling 5-hour window
- A reported tick is partial restoration, not a full reset
- `limited` is `true` when `remaining` hits 0
- `max` varies by subscription level (e.g. 400 standard, 600 founder's pack)

**Weekly mana bar** — longer-term budget:
- A single quota that scales by token costs and cache hits (cache hits discounted 80%)
- Regeneration timing does not establish a full reset date
- `percentRemaining` (0–100) tracks how much budget remains

**Subscription** — legacy request count per billing period.

**Search** — separate hourly quota for search requests.

## Plan Detection

No plan name is returned by the API. The plugin does not set a plan label.

## Displayed Lines

| Line            | Scope    | Condition                                                 | Description                                   |
|-----------------|----------|-----------------------------------------------------------|-----------------------------------------------|
| Weekly          | overview | Valid `planWeeklyLimit`                                  | Current weekly plan, primary metric           |
| Next Regen      | detail   | New plan reports `nextRegenAt`                            | UTC partial-regeneration instant              |
| Regen Percent   | detail   | New plan reports `nextRegenPercent`                       | Reported regeneration percentage points       |
| 5h Rate Limit   | overview | `rollingFiveHourLimit.max` and `remaining` are numeric    | Usage in 5-hour rolling window (used / limit) |
| Mana Bar        | overview | `weeklyTokenLimit.percentRemaining` is numeric            | Weekly token budget as percentage used        |
| Rate Limited    | detail   | `rollingFiveHourLimit.limited`                            | Red badge shown only when actively rate limited |
| Subscription    | overview | `subscription` present and no usable v3 quota lines exist | Legacy request count for billing period       |
| Free Tool Calls | detail   | `freeToolCalls.limit > 0` and no usable v3 quota lines exist | Legacy free tool-call quota                |
| Search          | detail   | `search.hourly` present                                   | Hourly search request quota                   |

Weekly is primary for new plans. Older plans retain their existing primary metric selection.

Progress lines include:
- 5h Rate Limit / Mana Bar: usage fields only, with no reset metadata
- Subscription / Free Tool Calls: `resetsAt` from `renewsAt`
- Search: `resetsAt` from `renewsAt` and `periodDurationMs = 3600000`

## Errors

| Condition              | Message                                                                   |
|------------------------|---------------------------------------------------------------------------|
| No API key found       | "Synthetic API key not found. Set SYNTHETIC_API_KEY or add key to ~/.pi/agent/auth.json" |
| 401/403                | "API key invalid or expired. Check your Synthetic API key."               |
| Other non-2xx          | "Synthetic request failed (HTTP {status}). Try again later."             |
| Invalid new plan      | "Synthetic weekly plan usage is unavailable. Try again later."           |
| Unparseable response   | "Could not parse usage data."                                             |
| Network error          | "Request failed. Check your connection."                                  |

Raw API error bodies are not displayed or copied into plugin logs. These new response rules are
based on [CodexBar's fixed implementation](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/Sources/CodexBarCore/Resources/Plugins/synthetic.js).
