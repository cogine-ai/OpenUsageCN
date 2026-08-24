# Codex

> Reverse-engineered, undocumented API. May change without notice.

## Overview

- **Protocol:** REST (plain JSON)
- **Base URL:** `https://chatgpt.com`
- **Auth provider:** `auth.openai.com` (OAuth 2.0)
- **Client ID:** `app_EMoamEEZ73f0CkXaXp7hrann`
- **Percentages:** integers (0-100)
- **Timestamps:** unix seconds
- **Window durations:** seconds (18000 = 5h, 604800 = 7d)

Codex is enabled by default in the Windows MVP. Windows reads the same remote quota, credits, and manual reset data, but does not run `ccusage`; the local `今日`, `昨日`, `近30天`, and `用量趋势` lines are therefore omitted.

## Endpoints

### GET /backend-api/wham/usage

Returns rate limit windows, optional credits, and the number of available manual resets.

#### Headers

| Header | Required | Value |
|---|---|---|
| Authorization | yes | `Bearer <access_token>` |
| Accept | yes | `application/json` |
| ChatGPT-Account-Id | no | `<account_id>` |

#### Response

```jsonc
{
  "plan_type": "plus",                     // plan tier
  "rate_limit": {
    "primary_window": {                     // first returned window
      "used_percent": 6,                   // % used in 5h rolling window
      "reset_at": 1738300000,              // unix seconds
      "limit_window_seconds": 18000        // 5 hours
    },
    "secondary_window": {                   // optional second window
      "used_percent": 24,                  // % used in 7-day window
      "reset_at": 1738900000,
      "limit_window_seconds": 604800       // 7 days
    }
  },
  "code_review_rate_limit": {              // separate weekly code review limit (optional)
    "primary_window": {
      "used_percent": 0,
      "reset_at": 1738900000,
      "limit_window_seconds": 604800
    }
  },
  "credits": {                             // purchased credits (optional)
    "has_credits": true,
    "unlimited": false,
    "balance": 820.6969075                 // remaining credits
  },
  "rate_limit_reset_credits": {            // on-demand resets (optional)
    "available_count": 1
  }
}
```

Window type is determined by `limit_window_seconds`, not by whether it appears under
`primary_window` or `secondary_window`. The API can return one or both windows. When the 5-hour
window is unavailable, the 7-day window can appear by itself under `primary_window`.

OpenUsageCN floors the remaining credit balance to a whole number and displays its fixed USD
equivalent at `$0.04` per credit. For example, `820.6969075` renders as
`$32.80 · 820 点数`. The credit balance is unbounded; the API does not provide a maximum.

The plan identifiers `prolite`, `pro_lite`, and `pro-lite` are displayed as `Pro 5x`. Matching
ignores surrounding whitespace and letter case.

The Codex card uses short Chinese labels: `5小时`, `每周`, `代码审查`, `手动重置`, `点数`,
`今日`, `昨日`, `近30天`, and `用量趋势`. `5小时` is shown only when an 18000-second window is
present. Model names and the `tokens` unit stay unchanged.

Token totals keep one decimal place. Values below `1万` use the original number, values from `1万`
to below `0.1亿` use `万`, and values from `0.1亿` use `亿`. For example, `6005000` is shown as
`600.5万 tokens`.

### GET /backend-api/wham/rate-limit-reset-credits

Returns the manual reset inventory, including each reset's status and expiry time.

#### Headers

| Header | Required | Value |
|---|---|---|
| Authorization | yes | `Bearer <access_token>` |
| Accept | yes | `application/json` |
| ChatGPT-Account-Id | no | `<account_id>` |
| OpenAI-Beta | yes | `codex-1` |
| originator | yes | `Codex Desktop` |

#### Response

```jsonc
{
  "credits": [
    {
      "id": "<reset_credit_id>",
      "status": "available",
      "expires_at": "2026-07-18T00:39:53Z"
    }
  ],
  "available_count": 1
}
```

OpenUsageCN ignores redeemed and expired resets, then shows the nearest valid expiry. Examples are
`2 次可用 · 下一个2天3时后过期`, `2 次可用 · 下一个 18小时后过期`, and
`2 次可用 · 下一个 <1小时后过期`. Expiries under 24 hours use a warning color.

## Authentication

### Credential Storage Locations

Codex CLI supports multiple credential storage modes:

- **file** (default): `CODEX_HOME/auth.json` (or `~/.codex/auth.json` by default)
- **keyring**: OS keychain/credential manager entry (service name `Codex Auth`)
- **auto**: keyring first, fallback to file
- **ephemeral**: memory-only (no persistence)

For `keyring`/`auto`, Codex may not keep `auth.json` on disk. If keyring save succeeds, Codex removes the fallback `auth.json`.

OpenUsageCN Codex plugin auth lookup order on macOS:

1. `CODEX_HOME/auth.json` (when `CODEX_HOME` is set)
2. `~/.config/codex/auth.json`
3. `~/.codex/auth.json`
4. macOS keychain service `Codex Auth` (fallback)

On Windows:

1. `CODEX_HOME/auth.json` when `CODEX_HOME` is set.
2. `%USERPROFILE%\.codex\auth.json` otherwise.

The Windows MVP does not read Windows Credential Manager or use the macOS Keychain API. If the file is missing or invalid, run `codex` to sign in and create file-based credentials.

On Windows, set `CODEX_HOME` for your user before the app starts, then fully exit and restart OpenUsageCN. A PowerShell `$env:CODEX_HOME` value is visible only when OpenUsageCN is launched from that terminal session.

If file-based OAuth credentials are missing, invalid, or fail with an auth/session error during refresh or usage lookup, OpenUsageCN tries the macOS keychain fallback. Non-auth usage failures, such as server errors or invalid responses, are shown directly.

Keychain fallback is available on macOS only. If `auth.json` or the macOS `Codex Auth` keychain item changes while OpenUsageCN is refreshing a token, it reloads that source and saves the refreshed tokens only when the account and original refresh token still match. It never overwrites credentials already rotated by Codex.

Expected auth payload shape (file or keychain JSON value):

```jsonc
{
  "OPENAI_API_KEY": null,                  // legacy API key field
  "tokens": {
    "access_token": "<jwt>",               // OAuth access token (Bearer)
    "refresh_token": "<token>",
    "id_token": "<jwt>",                   // OpenID Connect ID token
    "account_id": "<uuid>"                 // sent as ChatGPT-Account-Id header
  },
  "last_refresh": "2026-01-28T08:05:37Z"  // ISO 8601
}
```

> Note: Codex also stores MCP OAuth tokens in `~/.codex/.credentials.json` (or keyring), but that is separate from ChatGPT CLI auth used by this plugin.

### Token Refresh

Access tokens are short-lived JWTs. Refreshed when `last_refresh` is older than 8 days, or on 401/403.

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

```
grant_type=refresh_token
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&refresh_token=<refresh_token>
```

Response returns new `access_token`, and optionally new `refresh_token` and `id_token`.
