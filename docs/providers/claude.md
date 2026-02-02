# Claude Code Usage API

Claude Code uses Anthropic's OAuth-based API to fetch usage data. The usage endpoint returns rate limit windows and optional extra credits information as JSON.

**Note:** This is a reverse-engineered, undocumented API. It may change without notice.

## Endpoint

```
GET https://api.anthropic.com/api/oauth/usage
```

### Required Headers

```
Authorization: Bearer <access_token>
Accept: application/json
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
```

### Response

```jsonc
{
  "five_hour": {
    "utilization": 25,              // % used in 5h rolling window
    "resets_at": "2026-01-28T15:00:00Z"
  },
  "seven_day": {
    "utilization": 40,              // % used in 7-day window
    "resets_at": "2026-02-01T00:00:00Z"
  },
  "seven_day_opus": {               // separate weekly limit for Opus (optional)
    "utilization": 0,
    "resets_at": "2026-02-01T00:00:00Z"
  },
  "extra_usage": {                  // on-demand / overage credits (optional)
    "is_enabled": true,
    "used_credits": 500,            // cents -- amount spent
    "monthly_limit": 10000,         // cents -- monthly cap
    "currency": "USD"
  }
}
```

#### Rate Limit Windows

The API tracks multiple concurrent usage windows:

| Window | Field | Duration | Description |
|---|---|---|---|
| **Primary** | `five_hour` | 5 hours | Short-term rolling limit. Resets continuously |
| **Secondary** | `seven_day` | 7 days | Weekly rolling limit. Resets continuously |
| **Opus** | `seven_day_opus` | 7 days | Separate weekly limit for Claude Opus model (when present) |

All windows are enforced simultaneously -- hitting any limit throttles the user.

#### extra_usage: On-Demand Credits

Optional object for on-demand overage spending. Fields:

| Field | Type | Description |
|---|---|---|
| `is_enabled` | boolean | Whether on-demand credits are active |
| `used_credits` | number | Amount spent in cents |
| `monthly_limit` | number | Monthly cap in cents (0 = unlimited) |
| `currency` | string | Currency code (e.g. "USD") |

## Authentication

Claude Code uses OAuth tokens issued by Anthropic's auth system.

### Token Locations (macOS)

**Primary: Credentials file**

```
~/.claude/.credentials.json
```

File structure:

```jsonc
{
  "claudeAiOauth": {
    "accessToken": "<jwt>",          // OAuth access token (Bearer)
    "refreshToken": "<token>",       // used to obtain new access tokens
    "expiresAt": 1738300000000,      // unix ms -- token expiration
    "scopes": ["..."],               // granted OAuth scopes
    "subscriptionType": "pro",       // plan tier
    "rateLimitTier": "..."           // rate limit tier
  }
}
```

**Fallback: macOS Keychain**

Service name: `Claude Code-credentials`

The keychain entry contains the same JSON structure as the credentials file.

### Token Refresh

Access tokens are short-lived JWTs. The `expiresAt` field indicates when the token expires (unix milliseconds). If expired, the plugin will automatically refresh using the `refreshToken`.

**Refresh endpoint:**

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
```

**Request body:**

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "<refresh_token>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers"
}
```

**Response:**

```json
{
  "access_token": "<new_jwt>",
  "refresh_token": "<new_refresh_token>",
  "expires_in": 3600
}
```

| Field | Type | Description |
|---|---|---|
| `access_token` | string | New OAuth access token |
| `refresh_token` | string | New refresh token (may be same as previous) |
| `expires_in` | number | Token lifetime in seconds |

The plugin refreshes proactively when the token is within 5 minutes of expiration, or reactively on 401/403 responses. Updated credentials are persisted back to the original source (file or keychain).

## Usage Example (curl)

```bash
ACCESS_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.claude/.credentials.json'))['claudeAiOauth']['accessToken'])")

curl -s "https://api.anthropic.com/api/oauth/usage" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "anthropic-beta: oauth-2025-04-20" | python3 -m json.tool
```

## Usage Example (TypeScript)

```typescript
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

interface UsageWindow {
  utilization: number;
  resets_at?: string;
}

interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_opus?: UsageWindow;
  extra_usage?: {
    is_enabled?: boolean;
    used_credits?: number;
    monthly_limit?: number;
    currency?: string;
  };
}

function getClaudeCredentials(): ClaudeOAuth | null {
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) return null;

  const data = JSON.parse(readFileSync(credPath, "utf-8"));
  return data.claudeAiOauth ?? null;
}

async function getClaudeUsage(): Promise<UsageResponse> {
  const creds = getClaudeCredentials();
  if (!creds?.accessToken) throw new Error("Claude credentials not found");

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

## Technical Details

- **Protocol:** REST (plain JSON)
- **HTTP method:** GET (usage), POST (token refresh)
- **Usage domain:** `api.anthropic.com`
- **OAuth domain:** `platform.claude.com`
- **Beta header:** `anthropic-beta: oauth-2025-04-20` (required for usage endpoint)
- **Client ID:** `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **Utilization is a percentage** (0-100)
- **Credits are in cents** (divide by 100 for dollars)
- **Timestamps are ISO 8601** (not unix)
- **Expiration times are unix milliseconds** (in credentials file)
- **Token refresh:** JSON body (not form-encoded)

## Open Questions

- [x] What OAuth refresh endpoint does Claude Code use? → `https://platform.claude.com/v1/oauth/token`
- [ ] Is `seven_day_opus` always present, or only for certain plans?
- [ ] Are there additional rate limit windows for different plan tiers (e.g. Max)?
- [x] What scopes are required for the usage endpoint? → `user:inference` (minimum), full set: `user:profile user:inference user:sessions:claude_code user:mcp_servers`
