# Z.ai

Tracks [Z.ai](https://z.ai) (Zhipu AI) usage quotas for GLM coding plans.

Z.ai is included in the Windows MVP and is disabled until you configure and enable it.

> These API endpoints are not documented in Z.ai's public API reference. They are used internally by the subscription
> management UI and work with both OAuth tokens and API keys.

## Overview

- **Protocol:** REST (plain JSON)
- **Base URL:** `https://api.z.ai/`
- **Auth:** API key from Settings, or environment variable fallback (`ZAI_API_KEY`, fallback `GLM_API_KEY`)
- **Session utilization:** percentage (0-100)
- **Weekly utilization:** percentage (0-100)
- **Web searches:** count-based (used / limit)
- **Quota windows:** 5 hours (session), 7 days (weekly); web search windows follow the quota response
- **Reset times:** shown only when the quota API provides a valid timestamp

Both current credit plans (`CREDIT_LIMIT`) and older token plans (`TOKENS_LIMIT`) are supported.
The card uses the provider's used percentage for each window; credits are not relabeled as tokens.
Session, Weekly, and Web Searches load independently, so a missing Session does not hide the other quotas.

## Setup

1. [Subscribe to a GLM Coding plan](https://z.ai/subscribe) and get your API key from
   the [Z.ai console](https://z.ai/manage-apikey/apikey-list)
2. Open OpenUsageCN Settings and paste it into the Z.ai `API Key` field.
3. Enable the Z.ai plugin in OpenUsageCN settings.

The Settings value is used first. If the field is empty, `ZAI_API_KEY` is supported as an environment fallback.
`GLM_API_KEY` is also supported as a second fallback.

API keys entered in Settings are stored as plaintext. macOS uses `~/.openusagecn/providers.json`; Windows uses `%LOCALAPPDATA%\ai.cogine.openusagecn\providers.json`. The file is limited by normal user-profile permissions, but another process running as the same user can read it.

If you use environment variables, remember that OpenUsageCN is a GUI app. A one-off `export ...` in a terminal session will not be visible when you launch OpenUsageCN from
Spotlight/Launchpad. Persist it, then restart OpenUsageCN.

On Windows, set the variable for your user before launching OpenUsageCN, then fully exit and restart the app. A PowerShell `$env:` value is visible only when OpenUsageCN is launched from that same terminal session.

zsh (`~/.zshrc`):

```bash
export ZAI_API_KEY="YOUR_API_KEY"
```

fish (universal var):

```fish
set -Ux ZAI_API_KEY "YOUR_API_KEY"
```

## Endpoints

### GET /api/biz/subscription/list

Returns the user's active subscription(s). Used to extract the plan name.

#### Headers

| Header        | Required | Value              |
|---------------|----------|--------------------|
| Authorization | yes      | `Bearer <api_key>` |
| Accept        | yes      | `application/json` |

#### Response

```json
{
  "code": 200,
  "data": [
    {
      "id": "169359",
      "customerId": "71321768207710758",
      "productName": "GLM Coding Max",
      "description": "-All Pro plan benefits\n-4× Pro plan usage...",
      "status": "VALID",
      "purchaseTime": "2026-01-12 16:55:13",
      "valid": "2026-02-12 16:55:13-2026-03-12 16:55:13",
      "autoRenew": 1,
      "initialPrice": 30.0,
      "actualPrice": 30.0,
      "currentPeriod": 2,
      "currentRenewTime": "2026-01-12",
      "nextRenewTime": "2026-02-12",
      "billingCycle": "monthly",
      "inCurrentPeriod": true,
      "paymentChannel": "STRIPE"
    }
  ],
  "success": true
}
```

Used fields:

- `productName` — plan display name (e.g. "GLM Coding Max")

Subscription renewal dates are not used to guess quota reset times.

### GET /api/monitor/usage/quota/limit

Returns session and weekly token or credit usage, plus optional web search quotas.

#### Headers

| Header        | Required | Value              |
|---------------|----------|--------------------|
| Authorization | yes      | `Bearer <api_key>` |
| Accept        | yes      | `application/json` |

#### Response

```json
{
  "code": 200,
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "usage": 800000000,
        "currentValue": 127694464,
        "remaining": 672305536,
        "percentage": 15,
        "nextResetTime": 1770648402389
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "number": 1,
        "usage": 4000,
        "currentValue": 1828,
        "remaining": 2172,
        "percentage": 45,
        "usageDetails": [
          {
            "modelCode": "search-prime",
            "usage": 1433
          },
          {
            "modelCode": "web-reader",
            "usage": 462
          },
          {
            "modelCode": "zread",
            "usage": 0
          }
        ]
      }
    ]
  },
  "success": true
}
```

**TOKENS_LIMIT / CREDIT_LIMIT:**

- `usage`, `currentValue`, `remaining` — provider-native amounts; token and credit plans use different units
- `percentage` — usage as percentage (0-100)
- `nextResetTime` — epoch milliseconds of next reset
- `unit: 3, number: 5` — 5-hour rolling period (session)
- `unit: 6, number: 1` — one week (weekly)

Window lengths use both `unit` and `number`: unit `1` means days, `3` hours, `5` minutes, and `6` weeks.
Equivalent seven-day windows are accepted, such as `unit: 1, number: 7`.
Missing or unsupported window metadata is not treated as five hours or one week.

**TIME_LIMIT:**

- `usage` — total web search/reader call limit (e.g. 4000)
- `currentValue` — calls consumed
- `remaining` — calls remaining
- `percentage` — usage as percentage (0-100)
- `usageDetails` — per-model breakdown (search-prime, web-reader, zread)
- `unit: 5, number: 1` — monthly MCP marker, not a one-minute window

Web search counts remain visible without a reset timestamp. OpenUsageCN does not invent a first-of-month
reset or a fixed 30-day pace estimate. Other reported web-search durations use their actual unit and number.

## Displayed Lines

| Line         | Description                                                                  |
|--------------|------------------------------------------------------------------------------|
| Session      | Token or credit quota used in the five-hour window                         |
| Weekly       | Token or credit quota used in the seven-day window                         |
| Web Searches | Web search/reader call count (used / limit)                                 |

An invalid quota shows **Usage unavailable** while valid quotas keep loading. An unrecognized quota
shows **Some usage unavailable**. Missing or invalid numbers are never displayed as zero usage.
If no valid quota remains, refresh fails and the app keeps the last successful snapshot with an error.
An explicitly empty quota list still shows **No usage data**.

## Errors

| Condition     | Message                                                    |
|---------------|------------------------------------------------------------|
| No API key    | "No Z.ai API key found. Add it in Settings or set ZAI_API_KEY/GLM_API_KEY." |
| 401/403       | "API key invalid. Check your Z.ai API key."                |
| HTTP error    | "Usage request failed (HTTP {status}). Try again later."   |
| Network error | "Usage request failed. Check your connection."             |
| Invalid JSON  | "Usage response invalid. Try again later."                 |
| Invalid quota | "Quota data is incomplete or invalid. Try again later."    |

## References

- [Z.ai credit allowance and reset rules](https://docs.z.ai/devpack/overview)
- [CodexBar quota format and window mapping](https://github.com/steipete/CodexBar/blob/4f760cfc9b5e1b9540ba35fbe976e15d24c3b5ae/Sources/CodexBarCore/Resources/Plugins/zai.js)
