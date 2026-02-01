# Codex (CLI) Usage API

Codex uses OpenAI's ChatGPT backend API to fetch usage data. The usage endpoint returns rate limit windows and optional code review / credits information as JSON.

**Note:** This is a reverse-engineered, undocumented API. It may change without notice.

## Endpoint

```
GET https://chatgpt.com/backend-api/wham/usage
```

### Required Headers

```
Authorization: Bearer <access_token>
Accept: application/json
```

Optional:
```
ChatGPT-Account-Id: <account_id>
```

### Response

```jsonc
{
  "plan_type": "plus",                     // plan tier
  "rate_limit": {
    "primary_window": {
      "used_percent": 6,                   // % used in 5h rolling window
      "reset_at": 1738300000,              // unix seconds
      "limit_window_seconds": 18000        // 5 hours (18000s)
    },
    "secondary_window": {
      "used_percent": 24,                  // % used in 7-day window
      "reset_at": 1738900000,              // unix seconds
      "limit_window_seconds": 604800       // 7 days (604800s)
    }
  },
  "code_review_rate_limit": {              // separate weekly limit for code reviews
    "primary_window": {
      "used_percent": 0,
      "reset_at": 1738900000,
      "limit_window_seconds": 604800       // 7 days
    }
  },
  "credits": {                             // extra credits (if purchased)
    "has_credits": true,
    "unlimited": false,
    "balance": 5.39                        // credits balance remaining
  }
}
```

#### rate_limit: Rolling Windows

The `rate_limit` object tracks two concurrent usage windows:

| Window | Field | Duration | Description |
|---|---|---|---|
| **Primary** | `primary_window` | 5 hours | Short-term rolling limit. Resets continuously |
| **Secondary** | `secondary_window` | 7 days | Weekly rolling limit. Resets continuously |

Both windows are enforced simultaneously -- hitting either limit throttles the user.

#### code_review_rate_limit: Code Review Window

A separate rate limit for Codex's code review feature. Tracks a single weekly window. Only present when the user has code review access.

#### credits: Extra Credits

Optional object for purchased credit balance. Fields:

| Field | Type | Description |
|---|---|---|
| `has_credits` | boolean | Whether user has any credits |
| `unlimited` | boolean | Unlimited credits flag |
| `balance` | number | Remaining credits balance |

### x-codex Headers (Other Endpoints Only)

Some ChatGPT conversation endpoints (NOT `/wham/usage`) return usage info in response headers:

| Header | Description |
|---|---|
| `x-codex-primary-used-percent` | 5h window % used |
| `x-codex-secondary-used-percent` | 7d window % used |
| `x-codex-credits-balance` | Credits balance |

These headers do **not** appear on the `/wham/usage` endpoint itself.

## Authentication

Codex uses OAuth tokens issued by OpenAI's auth system.

### Token Location (macOS)

```
~/.codex/auth.json
```

File structure:

```jsonc
{
  "OPENAI_API_KEY": null,                  // legacy API key field (unused for OAuth)
  "tokens": {
    "access_token": "<jwt>",               // OAuth access token (Bearer)
    "refresh_token": "<token>",            // used to obtain new access tokens
    "id_token": "<jwt>",                   // OpenID Connect ID token
    "account_id": "<uuid>"                 // sent as ChatGPT-Account-Id header
  },
  "last_refresh": "2026-01-28T08:05:37Z"  // ISO 8601 timestamp of last refresh
}
```

### Token Refresh

Access tokens are short-lived JWTs. Refresh via:

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&refresh_token=<refresh_token>
```

Response returns new `access_token`, and optionally new `refresh_token` and `id_token`.

The plugin refreshes when `last_refresh` is older than 8 days, or on 401/403 responses.

## Usage Example (curl)

```bash
ACCESS_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.codex/auth.json'))['tokens']['access_token'])")
ACCOUNT_ID=$(python3 -c "import json; print(json.load(open('$HOME/.codex/auth.json'))['tokens'].get('account_id',''))")

curl -s "https://chatgpt.com/backend-api/wham/usage" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: application/json" \
  -H "ChatGPT-Account-Id: $ACCOUNT_ID" | python3 -m json.tool
```

## Technical Details

- **Protocol:** REST (plain JSON)
- **HTTP method:** GET
- **Base domain:** `chatgpt.com`
- **Auth provider:** `auth.openai.com` (OAuth 2.0)
- **Client ID:** `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI)
- **Percentages are integers** (0-100)
- **Timestamps are unix seconds** (not milliseconds)
- **Window durations are in seconds** (18000 = 5h, 604800 = 7d)

## Open Questions

- [ ] Credits: do they appear in the `/wham/usage` response for all plans, or only when purchased?
- [ ] Code review: is `code_review_rate_limit` always present, or gated by plan/feature flag?
- [ ] Are there additional rate limit windows for different plan tiers (e.g. Pro)?
