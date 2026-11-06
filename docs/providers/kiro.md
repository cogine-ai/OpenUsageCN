# Kiro

> Reverse-engineered from the shipped Kiro extension, local Kiro state, and local Kiro logs. The live API is not publicly documented and may change without notice.

## Overview

- **Product:** [Kiro](https://kiro.dev/)
- **Runtime service:** AWS CodeWhisperer Runtime (`https://q.<region>.amazonaws.com`)
- **Primary local state:** `~/Library/Application Support/Kiro/User/globalStorage/state.vscdb`
- **Primary local metadata fallback:** `~/Library/Application Support/Kiro/logs/*/window*/exthost/kiro.kiroAgent/q-client.log`
- **Auth token file:** `~/.aws/sso/cache/kiro-auth-token.json`
- **Profile fallback:** `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json`

OpenUsageCN uses Kiro's local normalized usage cache first, enriches it from Kiro's own runtime logs when available, and only falls back to the live refresh/API path when the local picture is missing or stale.

## Plugin Metrics

| Metric | Source | Scope | Format | Notes |
| --- | --- | --- | --- | --- |
| Credits | `usageBreakdowns[*]` | overview | count | Monthly included Kiro plan credits |
| Overage Credits | `currentOveragesWithPrecision` / `overageCapWithPrecision` | detail | count | Separate paid overage pool; never added to plan or bonus credits |
| Bonus Credits | `freeTrialUsage` or active `bonuses[0]` | overview | count | Free-trial / bonus credit pool when present |
| Overages | `overageConfiguration.overageStatus` | detail | badge | `Enabled` / `Disabled` |

The plan label comes from `subscriptionInfo.subscriptionTitle` when a recent `GetUsageLimits` response is available from logs or the live API.

## Local Sources

### 1) SQLite usage cache

Path: `~/Library/Application Support/Kiro/User/globalStorage/state.vscdb`

Key:

- `kiro.kiroAgent`

That JSON currently contains a nested key:

- `kiro.resourceNotifications.usageState`

Observed shape:

```json
{
  "usageBreakdowns": [
    {
      "type": "CREDIT",
      "currentUsage": 0,
      "usageLimit": 50,
      "resetDate": "2026-05-01T00:00:00.000Z",
      "displayName": "Credit",
      "displayNamePlural": "Credits",
      "freeTrialUsage": {
        "currentUsage": 106.11,
        "usageLimit": 500,
        "expiryDate": "2026-05-03T15:09:55.196Z",
        "daysRemaining": 27
      }
    }
  ],
  "timestamp": 1775500185544
}
```

This is the cleanest local source for the numeric usage lines.

### 2) q-client runtime logs

Path pattern:

```text
~/Library/Application Support/Kiro/logs/<session>/window*/exthost/kiro.kiroAgent/q-client.log
```

Kiro logs the full `GetUsageLimitsCommand` request/response. That response includes the fields missing from the SQLite cache, especially:

- `subscriptionInfo.subscriptionTitle`
- `subscriptionInfo.type`
- `overageConfiguration.overageStatus`
- full `usageBreakdownList`

OpenUsageCN uses the latest logged response to recover plan metadata without needing network access.

## Authentication

### Token file

Kiro's desktop extension stores auth in:

```text
~/.aws/sso/cache/kiro-auth-token.json
```

Observed fields:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": "2026-04-06T19:29:16.090Z",
  "authMethod": "social",
  "provider": "Google",
  "profileArn": "arn:aws:codewhisperer:us-east-1:699475941385:profile/..."
}
```

### Profile fallback

If `profileArn` is not embedded in the token file, Kiro also persists the selected profile:

```json
{
  "arn": "arn:aws:codewhisperer:us-east-1:699475941385:profile/...",
  "name": "Google"
}
```

## Live Refresh + Usage API

### Refresh social auth token

```http
POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken
Content-Type: application/json
User-Agent: KiroIDE-<version>-<machineId>
```

```json
{
  "refreshToken": "<refresh_token>"
}
```

Observed refresh response fields:

- `accessToken`
- `refreshToken`
- `expiresIn`
- `profileArn`

### Fetch usage

```http
GET https://q.<region>.amazonaws.com/getUsageLimits?origin=AI_EDITOR&profileArn=<profileArn>&resourceType=AGENTIC_REQUEST
Authorization: Bearer <accessToken>
Accept: application/json
```

Extra headers used by Kiro only for specific auth modes:

- `TokenType: EXTERNAL_IDP` for external IdP accounts
- `redirect-for-internal: true` for internal AWS accounts

Observed response fields:

- `nextDateReset`
- `overageConfiguration.overageStatus`
- `subscriptionInfo.subscriptionTitle`
- `subscriptionInfo.type`
- `usageBreakdownList[*]`
- `userInfo.userId`

## Provider Strategy in OpenUsageCN

1. Require Kiro auth token presence so stale post-logout cache data is not shown as an active account.
2. Read `state.vscdb` for the normalized numeric usage view.
3. Read the latest `q-client.log` `GetUsageLimitsCommand` response for plan and overage metadata.
4. If the local cache is missing, incomplete, or older than the app's staleness threshold, call the live refresh/API path.
5. If live fetch fails but the local cache is usable, keep showing the last local snapshot.

## Kiro CLI Sign-In

If the desktop token file is absent, OpenUsageCN can read the existing Kiro CLI sign-in.
Run `kiro-cli login` if this connection is missing or expired. The connection recovery page
can copy this command for you; it never executes the command or starts a CLI login automatically.
The app never renews, rewrites,
or deletes CLI credentials. An existing desktop sign-in remains preferred, including when it
is unreadable or expired; a failed request never switches to another account.

The default macOS database is `~/Library/Application Support/kiro-cli/data.sqlite3`.
`KIRO_DATA_DIR` can select its directory. Outside macOS the default is
`$XDG_DATA_HOME/kiro-cli/data.sqlite3`, or `~/.local/share/kiro-cli/data.sqlite3`.
The database is opened read-only, without an immutable fallback to stale WAL state.

The CLI's `auth_kv` token and `state` profile stay together. A Builder ID sign-in without a
profile uses the fixed US endpoint. A present but invalid profile or unsupported region is
rejected. US and Frankfurt profiles use their verified AWS endpoints; credentials are never
sent to a hostname constructed from arbitrary profile text.

CLI usage comes from its own read-only `GetUsageLimits` API request, not desktop logs or caches.
If the token, profile, database location, or preferred sign-in source changes while reading,
the older response is rejected. The API uses POST to retrieve usage; it does not send a model prompt.

## Separate Credit Pools

API total usage includes overage. For total usage 120, plan limit 100, and overage 20 with a
50-credit cap, the app shows **Credits 100 / 100** and **Overage Credits 20 / 50**.
The `credits`, `bonusCredits`, and `overageCredits` API resources remain separate.
Overage above its cap keeps the reported amount rather than being clamped.

Bonus usage can be included in the API total without a precise plan split. In that case the
plan meter shows **Usage unavailable**, while valid bonus and overage pools remain visible.
An already separated desktop cache can retain its own plan meter. **Bonus Expiry** is displayed
as a separate UTC timestamp; it is not a quota reset or a prediction that the bonus will refill.
Bonus progress does not export that expiry as a resource reset. Missing overage is not
shown as zero, and an unknown enabled/disabled status is not labeled disabled.

The CLI protocol and pool separation follow the fixed
[CodexBar implementation](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/Sources/CodexBarCore/Providers/Kiro/KiroUsageLimitsAPI.swift).
The private API may change. Synthetic tests do not establish real-account acceptance.


### 来源变化与旧用量

用量缓存会检查所选桌面/CLI 登录来源。来源变化后，旧结果不作为新登录的额度；新来源失败时会移除不匹配的旧读数，同一来源的失败仍可保留上次结果。旧版没有来源记录的缓存需要重新刷新。

为避免猜测两个令牌属于同一账号，桌面端正常续期更新令牌后，第一次结果也可能提示连接已变化，重新刷新即可。CLI 数据库或 WAL 变更会保守地让旧结果失效。此检查只读文件，不修改登录；原有桌面续期逻辑不变，CLI 凭据始终只读。
