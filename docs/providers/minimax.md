# MiniMax

> Tracks MiniMax Token Plan through the existing API key source or an explicitly selected China website session.

## Overview

- **Protocol:** HTTPS (JSON)
- **Endpoint:** `GET https://www.minimax.io/v1/token_plan/remains`
- **Auth:** `Authorization: Bearer <api_key>`
- **Window model:** Token Plan remaining usage, returned as counts or percent

## Choose A Source

**API Key** remains the default and keeps the environment lookup and region behavior below. Select **China Web** explicitly to use the China website's weekly and boosted quotas. A China Web error never falls back to an API key or another region.

For China Web, sign in at [MiniMax China usage](https://platform.minimax.cn/console/usage), copy the `Cookie` request header from a usage request in browser developer tools, and paste it into **Settings → MiniMax → Cookie Header**. Automatic browser import is not used. The Cookie uses the app's existing local `providers.json` storage, which is not encrypted at rest.

## API Key Authentication

The plugin supports automatic region detection and reads API keys based on the selected region:

**Region auto-selection:**
- If `MINIMAX_CN_API_KEY` is set: tries `CN` first, then `GLOBAL`
- If `MINIMAX_CN_API_KEY` is not set: tries `GLOBAL` first, then `CN`

**Key lookup by region:**
- **CN region**: `MINIMAX_CN_API_KEY` → `MINIMAX_API_KEY` → `MINIMAX_API_TOKEN`
- **GLOBAL region**: `MINIMAX_API_KEY` → `MINIMAX_API_TOKEN`

If no key is found after attempting both regions, it throws:

- `MiniMax API key missing. Set MINIMAX_API_KEY or MINIMAX_CN_API_KEY.`

## Data Source

Request:

```http
GET /v1/token_plan/remains HTTP/1.1
Host: www.minimax.io
Authorization: Bearer <api_key>
Content-Type: application/json
Accept: application/json
```

Global requests use:

- `https://www.minimax.io/v1/token_plan/remains`

When the selected region is `CN`, requests use:

- `https://api.minimaxi.com/v1/token_plan/remains`

Expected payload fields:

- `base_resp.status_code` / `base_resp.status_msg`
- `model_remains[]`
- `model_remains[].current_interval_total_count`
- `model_remains[].current_interval_usage_count`
- optional remaining aliases (`current_interval_remaining_count`, `current_interval_remains_count`)
- optional remaining percent fields (`current_interval_remaining_percent`)
- `model_remains[].start_time`
- `model_remains[].end_time`
- `model_remains[].remains_time`
- optional plan fields (`current_subscribe_title`, `plan_name`, `plan`)

## Usage Mapping

- Treat `current_interval_usage_count` as remaining prompts (MiniMax remains API behavior).
- If only remaining aliases are provided, compute `used = total - remaining`.
- If explicit used-count fields are provided, prefer them.
- If count totals are missing or too small to display after CN scaling, fall back to a valid `current_interval_remaining_percent`.
- Plan name is taken from explicit plan/title fields when available.
- If plan fields are missing in GLOBAL mode, infer plan tier from known limits (`100/300/1000/2000` prompts or `1500/4500/15000/30000` model-call equivalents).
- If plan fields are missing in CN mode, infer only exact known CN limits (`600/1500/4500` model-call counts).
- Use `end_time` for reset timestamp when present.
- Fallback to `remains_time` when `end_time` is absent.
- Use `start_time` + `end_time` as `periodDurationMs` when both are valid.

## Output

- **Plan**: best-effort from API payload (normalized to concise label, with ` (CN)` or ` (GLOBAL)` suffix)
- **Session** (overview progress line):
  - `label`: `Session`
  - Count format when totals are available:
    - `format`: count (`prompts`)
    - `used`: computed used prompts
    - `limit`: total prompt limit for current window
  - Percent format when count totals are unavailable:
    - `format`: percent
    - `used`: `100 - current_interval_remaining_percent`
    - `limit`: `100`
  - `resetsAt`: derived from `end_time` or `remains_time`

## Errors

| Condition | Message |
|---|---|
| Missing API key | `MiniMax API key missing. Set MINIMAX_API_KEY or MINIMAX_CN_API_KEY.` |
| HTTP 401/403 | `Session expired. Check your MiniMax API key.` |
| API status `base_resp.status_code != 0` | `MiniMax API error: ...` (or session-expired for auth-like errors) |
| Non-2xx | `Request failed (HTTP {status}). Try again later.` |
| Network failure | `Request failed. Check your connection.` |
| Unparseable payload | `Could not parse usage data.` |

## China Web Usage

The website source sends the configured Cookie to `GET https://www.minimax.cn/backend/account/token_plan/remains_percent`. It does not send an API key. This endpoint is a website implementation detail and can change.

- **Session** and **Weekly** show the returned text-generation quota percentage. A window with explicit 45% used against a returned 150% total appears as 30% used. If total percent is absent, a separate boost changes only the capacity description, not the used percentage.
- **Session Capacity** and **Weekly Capacity** show a nonstandard quota multiplier, such as 150% of base quota. These percentages are not prompt counts.
- Both current `used_percent` / `total_percent` strings and older remaining-percent responses are supported, including the two observed boost field spellings.
- **Unlimited** appears as text without a progress bar or reset. An empty, excluded service lane is not treated as unlimited.
- Resets come from returned end timestamps or the website's countdown (seconds, or milliseconds for values above 1,000,000). An expired end timestamp falls back to a valid countdown. Pacing uses actual start/end timestamps when supplied; an unknown duration is not guessed.

Only the selected text-generation lane is shown. A general lane takes priority over model-specific text lanes, including legacy `m2.7` names; video and other excluded lanes do not become coding quotas. The existing API Key source's prompt-count scaling and plan inference are unchanged.

For this source, 401 means the web session expired; 403 means access was denied. Other HTTP, malformed-data and network errors show a fixed friendly message and do not include the server's raw response or Cookie in plugin logs.

Protocol reference: [CodexBar's fixed MiniMax parser and fixtures](https://github.com/steipete/CodexBar/blob/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/Tests/CodexBarTests/MiniMaxCurrentTokenPlanResponseTests.swift).
