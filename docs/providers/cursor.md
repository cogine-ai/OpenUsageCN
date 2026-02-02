# Cursor Usage API

Cursor uses [Connect RPC](https://connectrpc.com/) (by Buf) to communicate with its backend. The usage data visible in the Cursor settings panel is fetched via the `DashboardService` protobuf service over HTTP.

No protobuf encoding is needed -- the endpoints accept and return plain JSON.

## Endpoints

Base URL: `https://api2.cursor.sh`

### GetCurrentPeriodUsage

Returns current billing cycle spend, limits, and percentage used.

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
```

**Request body:** `{}`

**Response:**

```jsonc
{
  "billingCycleStart": "1768399334000",   // unix ms
  "billingCycleEnd": "1771077734000",     // unix ms
  "planUsage": {
    "totalSpend": 23222,                  // cents -- total $ used this cycle
    "includedSpend": 23222,               // cents -- portion counted against plan limit
    "bonusSpend": 0,                      // cents -- free credits from model providers (see below)
    "remaining": 16778,                   // cents -- remaining included budget
    "limit": 40000,                       // cents -- plan included amount
    "remainingBonus": false,              // true when bonus balance is still available
    "bonusTooltip": "We work with model providers to give you free usage beyond what you've purchased. Amounts may vary.",
    "autoPercentUsed": 0,                 // auto-mode usage %
    "apiPercentUsed": 46.444,             // API/manual usage %
    "totalPercentUsed": 15.48             // combined %
  },
  "spendLimitUsage": {                    // on-demand / overage budget (see below)
    "totalSpend": 0,                      // cents -- total on-demand spend
    "pooledLimit": 50000,                 // cents -- team-wide pool (team plans only, optional)
    "pooledUsed": 0,                      // cents -- team-wide used (optional)
    "pooledRemaining": 50000,             // cents -- team-wide remaining (optional)
    "individualLimit": 10000,             // cents -- per-user limit ($100)
    "individualUsed": 0,                  // cents -- per-user used
    "individualRemaining": 10000,         // cents -- per-user remaining
    "limitType": "user"                   // "user" | "team"
  },
  "displayThreshold": 200,               // show bar after this % threshold (basis points)
  "enabled": true,
  "displayMessage": "You've used 46% of your usage limit",
  "autoModelSelectedDisplayMessage": "You've used 15% of your included total usage",
  "namedModelSelectedDisplayMessage": "You've used 46% of your included API usage"
}
```

#### planUsage: Spend Buckets

The `planUsage` object tracks three distinct spend categories:

| Field | What it means |
|---|---|
| `includedSpend` | Spend counted against the plan's included budget (`limit`) |
| `bonusSpend` | Free credits provided by model providers at no cost to the user. Not counted against `limit`. Appears as bonus bar in Cursor UI |
| `totalSpend` | `includedSpend + bonusSpend` -- the total dollar value of usage |
| `remaining` | How much included budget is left (`limit - includedSpend`) |
| `remainingBonus` | `true` if there are still bonus credits available to consume |

When `bonusSpend > 0`, the user is getting free usage on top of their plan. The `bonusTooltip` explains this to the user.

#### spendLimitUsage: On-Demand Budget

The on-demand budget kicks in after the included plan amount is exhausted. It has two layers:

| Scope | Fields | Description |
|---|---|---|
| **Individual** | `individualLimit`, `individualUsed`, `individualRemaining` | Per-user on-demand cap (e.g. $100). Always present when on-demand is enabled |
| **Pooled** | `pooledLimit`, `pooledUsed`, `pooledRemaining` | Team-wide shared pool. Only present on team plans with pooled budgets |

The `limitType` indicates which scope applies: `"user"` for individual accounts, `"team"` for team-managed limits. On team plans, both individual and pooled fields may be present -- the individual cap acts as a per-member guardrail within the team pool.

### GetPlanInfo

Returns plan name, price, and included amount.

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo
```

**Request body:** `{}`

**Response:**

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

### GetUsageLimitPolicyStatus

Returns whether user is in slow pool, feature gates, and allowed models.

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetUsageLimitPolicyStatus
```

### GetUsageLimitStatusAndActiveGrants

Returns limit policy status plus any active credit grants.

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants
```

## Authentication

All requests require a Bearer token in the `Authorization` header. This is a JWT issued by Cursor's Auth0 tenant.

### Required Headers

```
Authorization: Bearer <access_token>
Content-Type: application/json
Connect-Protocol-Version: 1
```

### Token Location (macOS)

The access token is stored in a local SQLite database:

```
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
```

Table: `ItemTable`, key: `cursorAuth/accessToken`

Read it with:

```bash
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"
```

Other useful keys in the same table:

| Key | Description |
|---|---|
| `cursorAuth/accessToken` | JWT bearer token |
| `cursorAuth/refreshToken` | Token refresh credential |
| `cursorAuth/cachedEmail` | Account email |
| `cursorAuth/stripeMembershipType` | Plan tier (e.g. `pro`, `ultra`) |
| `cursorAuth/stripeSubscriptionStatus` | Subscription status |

### Token Refresh

Cursor's token is a short-lived JWT. If the token is expired, use the `refreshToken` to obtain a new one via Cursor's OAuth endpoint. The app checks token expiration before each request and triggers a refresh if needed.

**Refresh Endpoint:**

```
POST https://api2.cursor.sh/oauth/token
```

**Request:**

```json
{
  "grant_type": "refresh_token",
  "client_id": "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
  "refresh_token": "<refresh_token>"
}
```

**Headers:**

```
Content-Type: application/json
```

**Response (success):**

```json
{
  "access_token": "<new_jwt>",
  "id_token": "<id_token>",
  "shouldLogout": false
}
```

**Response (invalid/expired):**

```json
{
  "access_token": "",
  "id_token": "",
  "shouldLogout": true
}
```

When `shouldLogout` is `true`, the refresh token is invalid and the user must re-authenticate via the Cursor app.

**Token Expiration:**

- Access tokens are JWTs with an `exp` claim (Unix timestamp in seconds)
- Cursor refreshes tokens ~53 days before expiration (1272 hours)
- The OpenUsage plugin refreshes 5 minutes before expiration

## Usage Example (TypeScript)

```typescript
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";

function getCursorAccessToken(): string | null {
  const dbPath = join(
    homedir(),
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
  );
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get("cursorAuth/accessToken") as { value: string } | undefined;
  db.close();
  return row?.value ?? null;
}

async function getCursorUsage() {
  const token = getCursorAccessToken();
  if (!token) throw new Error("Cursor access token not found");

  const [usageRes, planRes] = await Promise.all([
    fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
      }
    ),
    fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
      }
    ),
  ]);

  const usage = await usageRes.json();
  const plan = await planRes.json();

  const su = usage.spendLimitUsage;
  const onDemandLimit = (su?.individualLimit ?? su?.pooledLimit ?? 0) / 100;
  const onDemandRemaining =
    (su?.individualRemaining ?? su?.pooledRemaining ?? 0) / 100;

  return {
    planName: plan.planInfo.planName,
    price: plan.planInfo.price,
    includedAmount: plan.planInfo.includedAmountCents / 100,
    totalSpend: usage.planUsage.totalSpend / 100,
    includedSpend: usage.planUsage.includedSpend / 100,
    bonusSpend: (usage.planUsage.bonusSpend ?? 0) / 100,
    remainingBonus: usage.planUsage.remainingBonus ?? false,
    remaining: usage.planUsage.remaining / 100,
    limit: usage.planUsage.limit / 100,
    percentUsed: usage.planUsage.apiPercentUsed,
    onDemandLimit,
    onDemandUsed: onDemandLimit - onDemandRemaining,
    onDemandLimitType: su?.limitType ?? "user",
    billingCycleEnd: new Date(Number(usage.billingCycleEnd)),
    displayMessage: usage.displayMessage,
  };
}
```

## Technical Details

- **Protocol:** Connect RPC v1 (`@connectrpc/connect` library)
- **Wire format:** JSON (also supports binary protobuf with `Content-Type: application/proto`)
- **Service:** `aiserver.v1.DashboardService`
- **HTTP method:** POST (all endpoints)
- **Compression:** gzip supported (optional)
- **HTTP versions:** HTTP/1.1 to `api2.cursor.sh`; HTTP/2 to `api3`/`api4`/`api5`
- **All amounts are in cents** (divide by 100 for dollars)
- **All timestamps are unix milliseconds** (as strings)

## Other API Domains

| Domain | Purpose |
|---|---|
| `api2.cursor.sh` | Primary backend (HTTP/1.1) |
| `api3.cursor.sh` | Telemetry, cmdk (HTTP/2) |
| `api4.cursor.sh` | Geo CPP, config (HTTP/2) |
| `api5.cursor.sh` | Agent backend (HTTP/2) |
| `repo42.cursor.sh` | Repository indexing |

## Notes

- This is a reverse-engineered, undocumented API. It may change without notice.
- The token is scoped to the logged-in Cursor user; there is no public API key.
- Cursor refreshes usage data every 5 minutes with a 30-second cache.
- The `displayThreshold` field (basis points) controls when the usage bar appears in the UI.
