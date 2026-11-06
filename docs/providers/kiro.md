# Kiro

> Reverse-engineered from the shipped Kiro extension and its usage API. The live API is not publicly documented and may change without notice.

## Overview

- **Product:** [Kiro](https://kiro.dev/)
- **Runtime service:** AWS CodeWhisperer Runtime (`https://q.<region>.amazonaws.com`)
- **Auth token file:** `~/.aws/sso/cache/kiro-auth-token.json`
- **Profile fallback:** `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json`

OpenUsageCN requests usage with the selected desktop or CLI sign-in on every refresh. Kiro's local usage cache and runtime logs are not used as current account usage because they cannot be reliably tied to the selected account.

## Plugin Metrics

| Metric | Source | Scope | Format | Notes |
| --- | --- | --- | --- | --- |
| Credits | `usageBreakdownList[*]` | overview | count | Monthly included Kiro plan credits |
| Overage Credits | `currentOveragesWithPrecision` / `overageCapWithPrecision` | detail | count | Separate paid overage pool; never added to plan or bonus credits |
| Bonus Credits | Active `freeTrialInfo` / `freeTrialUsage` or `bonuses[*]` | overview | count | Free-trial / bonus credit pool when present |
| Overages | `overageConfiguration.overageStatus` | detail | badge | `Enabled` / `Disabled` |

The plan label comes from `subscriptionInfo.subscriptionTitle` in the current live `GetUsageLimits` response.

## Usage Source

Desktop usage comes only from a successful live request with the selected token and profile.
A failed request never falls back to Kiro's unbound local usage cache or logs, even if they
look recent. OpenUsageCN may retain its own previously verified snapshot for the same sign-in
source, with its original update time. Changing the source clears incompatible readings.

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

1. Prefer the existing desktop sign-in. Only use CLI sign-in when the desktop token file is absent; unreadable or expired desktop credentials do not switch accounts.
2. Request desktop usage with the selected token and profile on every refresh. Keep the existing desktop token renewal path when needed.
3. Save a renewed desktop token only if the original token file still matches. A changed file stops the request and preserves the replacement sign-in; a save error is reported instead of using an unsaved token. This guard does not promise atomicity against every external file replacement.
4. Read CLI credentials and request their usage without renewing or writing those credentials.
5. On failure, keep only OpenUsageCN's own verified snapshot for the same source. Never promote Kiro's local usage cache or logs to a fresh account reading.

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
A valid active free-trial pool follows the same rule: it stays separate, and the main meter
is unavailable when its usage cannot be isolated. A zero plan allowance does not discard valid
bonus or free-trial pools. **Bonus Expiry** is displayed as a separate UTC timestamp; it is not a quota reset or a prediction that the bonus will refill.
Bonus progress does not export that expiry as a resource reset. Missing overage is not
shown as zero. If overage is enabled but its usage amount is missing, both the overage pool
and API-derived main pool are unavailable: the total cannot establish a precise plan-only amount.
An explicit zero overage amount still allows the plan meter to load.
An unknown enabled/disabled status is not labeled disabled.

The CLI protocol and pool separation follow the fixed
[CodexBar implementation](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/Sources/CodexBarCore/Providers/Kiro/KiroUsageLimitsAPI.swift).
The private API may change. Synthetic tests do not establish real-account acceptance.


### 来源变化与旧用量

用量缓存会检查所选桌面/CLI 登录来源。来源变化后，旧结果不作为新登录的额度；新来源失败时会移除不匹配的旧读数，同一来源的失败仍可保留上次结果。旧版没有来源记录的缓存需要重新刷新。

为避免猜测两个令牌属于同一账号，桌面端正常续期更新令牌后，第一次结果也可能提示连接已变化，重新刷新即可。CLI 数据库或 WAL 变更会保守地让旧结果失效。来源检查本身只读文件。桌面续期仅在原令牌文件仍匹配时保存，文件已被其他登录替换则停止，保留新登录；CLI 凭据始终只读。
