# Cursor

> Reverse-engineered, undocumented API. May change without notice.

## Overview

- **Protocol:** Connect RPC v1 (JSON over HTTP)
- **Base URL:** `https://api2.cursor.sh`
- **Service:** `aiserver.v1.DashboardService`
- **Auth provider:** Auth0 (via Cursor)
- **Client ID:** `KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB`
- **Amounts:** cents (divide by 100 for dollars)
- **Timestamps:** unix milliseconds (as strings)

## Plugin metrics

| Metric | Source field | Scope | Format | Notes |
|---|---|---|---|---|
| Credits | `GetCreditGrantsBalance` + `/api/auth/stripe.customerBalance` | overview | dollars | Combined total: active grant total + Stripe prepaid balance (negative `customerBalance`). Used stays based on grant usage. |
| Total usage | `planUsage.totalPercentUsed` | overview | percent (individual) / dollars (team) | Falls back to computed `(limit - remaining) / limit * 100` when `totalPercentUsed` is not finite. Free/individual payloads observed on 2026-03-06 may omit `limit`; plugin uses `totalPercentUsed` directly in that case. Team accounts use dollars format and still require `limit`. |
| Auto usage | `planUsage.autoPercentUsed` | detail | percent | Omitted when field is missing or non-finite |
| API usage | `planUsage.apiPercentUsed` | detail | percent | Omitted when field is missing or non-finite |
| Requests | `/api/usage` (enterprise) | overview | count | Enterprise accounts only; unchanged from previous behavior |
| On-demand | `spendLimitUsage` | detail | dollars | Only when individual or pooled limit > 0 |

**Enterprise flow** remains request-based via the REST `/api/usage` endpoint -- unchanged.

**Team detection**: an account is treated as "team" when `planName` is `"Team"`, or `spendLimitUsage.limitType` is `"team"`, or `spendLimitUsage.pooledLimit` is greater than `0`. Team accounts display Total usage in dollars; individual accounts display it as a percentage.

The Cursor plan identifier `pro_plus` is displayed as `Pro+`. Matching ignores surrounding
whitespace and letter case; other plan names keep the existing display formatting.

## Accounts

On macOS, OpenUsageCN discovers Cursor Desktop and Cursor CLI sessions independently. Sessions
with the same complete JWT subject become two connections to one account; different subjects stay
as separate accounts. Accounts are never merged by email or by the suffix after `|`.

The account selector supports two modes:

- **Auto** keeps the previous Cursor preference: Desktop normally wins, except a different CLI
  account wins when the Desktop account appears to be Free.
- Selecting an account pins it until **Auto** is chosen again.

Only the selected account is published to the overview, tray, notifications, CLI, and Local HTTP
API. Switching to an account without a snapshot shows loading instead of relabeling another
account's data.

Chrome and Arc accounts can be added by choosing an exact browser profile. Browser access is
explicit and macOS-only. OpenUsageCN uses the packaged `@steipete/sweet-cookie` helper to read a
SQLite snapshot and let macOS Keychain decrypt matching Cursor cookies. Cookies and raw account
subjects stay in memory; persisted account data contains random IDs, an identity fingerprint, the
chosen profile locator, and local labels. A saved browser connection is reacquired from that exact
profile after restart and can be detached at any time.

Local account-scoped probes verify `GET https://cursor.com/api/auth/me` against the complete JWT
subject before requesting quota. A refreshed Desktop token is written with one SQLite transaction
that requires the original access token and refresh token to remain unchanged. A scoped CLI
Keychain refresh stays in memory because macOS Keychain does not provide a compare-by-value update.
A concurrent login switch therefore cannot be overwritten. Model-history refreshes also stay in
memory.

## Model Usage

The selected account's detail page loads Model Usage on demand. It requests the current billing
cycle, capped to the latest 30 days, from
`POST https://cursor.com/api/dashboard/get-filtered-usage-events`. When reliable cycle metadata is
not available, it uses a bounded 30-day window. Every fetch first proves the session with
`/api/auth/me` and uses the same accepted session for all pages.

The view groups complete results by local date and raw model name and shows input, output, cache
write, and cache read tokens plus request counts. Local dates use the selected IANA time zone's
rules at each event, including daylight-saving changes inside the window. The UI sends only that
time zone, while the backend chooses the current time once for the refresh. Missing
optional counters are zero; invalid or inexact totals fail the refresh without replacing the last
complete result. A blank model name is displayed as `Unknown` but is not rewritten in storage.

`List-Price Equivalent` sums event-level model prices when present. `Metered Usage` is a separate
whole-window value and is shown only when every in-window event has a valid charged amount. These
figures describe dashboard data, not an invoice. If pagination, identity, numeric validation, or
account ownership cannot be proven, the previous complete aggregate remains visible as stale and
the incomplete result is not saved. Raw events and ownership fields are not persisted.

## Endpoints

### POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage

Returns current billing cycle spend, limits, and percentage used.

#### Headers

| Header | Required | Value |
|---|---|---|
| Authorization | yes | `Bearer <access_token>` |
| Content-Type | yes | `application/json` |
| Connect-Protocol-Version | yes | `1` |

#### Request

```json
{}
```

#### Response

```jsonc
{
  "billingCycleStart": "1768399334000",   // unix ms (string)
  "billingCycleEnd": "1771077734000",
  "planUsage": {
    "totalSpend": 23222,                  // cents — includedSpend + bonusSpend
    "includedSpend": 23222,               // cents — counted against plan limit
    "bonusSpend": 0,                      // cents — free credits from model providers
    "remaining": 16778,                   // cents — limit minus includedSpend
    "limit": 40000,                       // cents — plan included amount
    "remainingBonus": false,              // true when bonus credits still available
    "bonusTooltip": "...",
    "autoPercentUsed": 0,                 // auto-mode usage %
    "apiPercentUsed": 46.444,             // API/manual usage %
    "totalPercentUsed": 15.48             // combined %
  },
  "spendLimitUsage": {                    // on-demand budget (after plan exhausted)
    "totalSpend": 0,                      // cents
    "pooledLimit": 50000,                 // cents — team pool (team plans only, optional)
    "pooledUsed": 0,
    "pooledRemaining": 50000,
    "individualLimit": 10000,             // cents — per-user cap
    "individualUsed": 0,
    "individualRemaining": 10000,
    "limitType": "user"                   // "user" | "team"
  },
  "displayThreshold": 200,               // basis points
  "enabled": true,
  "displayMessage": "You've used 46% of your usage limit",
  "autoModelSelectedDisplayMessage": "...",
  "namedModelSelectedDisplayMessage": "..."
}
```

### POST /aiserver.v1.DashboardService/GetPlanInfo

Returns plan name, price, and included amount.

#### Headers

Same as above.

#### Request

```json
{}
```

#### Response

```json
{
  "planInfo": {
    "planName": "Ultra",
    "includedAmountCents": 40000,
    "price": "$200/mo",
    "billingCycleEnd": "1771077734000"
  }
}
```

### POST /aiserver.v1.DashboardService/GetUsageLimitPolicyStatus

Returns whether user is in slow pool, feature gates, and allowed models. Response undocumented.

### POST /aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants

Returns limit policy status plus any active credit grants. Response undocumented.

### GET /api/auth/stripe

Returns subscription and Stripe customer balance metadata from `cursor.com`.

#### Headers

| Header | Required | Value |
|---|---|---|
| Cookie | yes | `WorkosCursorSessionToken=<userId>%3A%3A<access_token>` |

#### Response (partial)

```json
{
  "membershipType": "ultra",
  "subscriptionStatus": "active",
  "customerBalance": -123456
}
```

`customerBalance` is in cents. Negative means customer credit/prepaid balance.

## Authentication

### Token Sources

The account-aware path reads Cursor Desktop SQLite and Cursor CLI Keychain independently so both
accounts remain available. The legacy single-account path keeps the original preference order:

1. **Cursor Desktop SQLite** (normally preferred)
2. **Cursor CLI Keychain** (fallback, or preferred for a different account when Desktop is Free)

#### 1) Cursor Desktop SQLite (preferred)

Path: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`

```bash
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"
```

| Key | Description |
|---|---|
| `cursorAuth/accessToken` | JWT bearer token |
| `cursorAuth/refreshToken` | Token refresh credential |
| `cursorAuth/cachedEmail` | Account email |
| `cursorAuth/stripeMembershipType` | Plan tier (e.g. `pro`, `ultra`) |
| `cursorAuth/stripeSubscriptionStatus` | Subscription status |

#### 2) Cursor CLI keychain (fallback)

OpenUsageCN reads Cursor CLI tokens from keychain:

- `cursor-access-token`
- `cursor-refresh-token`

To initialize CLI auth:

```bash
agent login
```

### Token Refresh

Access tokens are short-lived JWTs. The legacy single-account probe refreshes before a request and
persists the new access token back to its original SQLite or Keychain source. Account-scoped probes
verify the complete identity before use. Desktop writes use the guarded SQLite transaction described
above; CLI Keychain and model-history refreshes stay in memory and never overwrite the local source.

```
POST https://api2.cursor.sh/oauth/token
Content-Type: application/json
```

```json
{
  "grant_type": "refresh_token",
  "client_id": "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
  "refresh_token": "<refresh_token>"
}
```

**Success:**

```json
{
  "access_token": "<new_jwt>",
  "id_token": "<id_token>",
  "shouldLogout": false
}
```

**Invalid/expired token:**

```json
{
  "access_token": "",
  "id_token": "",
  "shouldLogout": true
}
```

When `shouldLogout` is `true`, the refresh token is invalid and the user must re-authenticate via Cursor.

### Session Cookie (for `cursor.com` endpoints)

Some web endpoints (for example `/api/auth/stripe` and enterprise `/api/usage`) use a session cookie instead of bearer auth:

```
WorkosCursorSessionToken=<userId>%3A%3A<access_token>
```

`userId` is derived from JWT `sub` (e.g. `google-oauth2|user_abc` -> `user_abc`).
