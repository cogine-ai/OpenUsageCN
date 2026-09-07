# OpenCode Go

OpenCode Go shows your account-wide subscription usage from OpenCode's usage API,
including usage from other devices and clients. Local conversation history is not
used to estimate your remaining account quota.

## Setup

Sign in to OpenCode Go in OpenCode as usual. OpenUsageCN reuses the saved Go API key:

1. `~/.local/share/opencode/auth.json`: the `opencode-go` entry with `type: "api"`.
2. If that entry is absent, the `credential` table in
   `~/.local/share/opencode/opencode.db`: only a record whose `integration_id` is
   `opencode-go` and whose value contains `type: "key"`.

The database is read-only. Keys belonging to other providers are never tried.
These are OpenCode's default data locations; custom data directories and preview
channel databases are not discovered by this plugin.

## What You See

| Metric | Meaning |
| --- | --- |
| Session | Usage in the current rolling five-hour window |
| Weekly | Usage in the current weekly window |
| Monthly | Usage in the current subscription billing cycle |

All three bars use the percentage and reset time returned by OpenCode. A reported
`0%` remains a valid reading, and fractional percentages are preserved. The reset
countdown is kept even at `0%`, because OpenCode can round a started session down
to zero. An untouched rolling window can also return a reset near five hours from
now; the plugin does not infer session activity from that value.

Monthly reset times come from the subscription, not from the first local session.
The API does not return the monthly window's start, so monthly pacing is not
estimated. Session and weekly pacing use their known five-hour and seven-day
lengths.

The provider remains `opencode-go`. Its machine-readable resource keys remain
`session`, `weekly`, and `monthly`, all measured in percent.

## When Something Goes Wrong

- **Not Detected:** Sign in to OpenCode Go. Local history alone cannot establish
  the account or fetch its limits.
- **Key Rejected:** Sign in again so OpenCode saves a working Go key.
- **No Subscription:** The key is valid but has no active Go subscription.
- **Access Denied:** Check the key's account permissions.
- **Too Many Requests:** Wait and refresh again later.
- **Unreadable Credentials:** Check OpenCode's local files. Broken storage is
  reported instead of being treated as a logged-out account.
- **Invalid Response Or Connection Failure:** Check your connection and proxy
  settings, or retry later.

A failed request never publishes empty or invented quotas. OpenUsageCN keeps the
last successful snapshot and shows the refresh error. Requests use the app's
normal HTTP client, including its proxy settings. The plugin does not write keys,
change the OpenCode login, or publish raw provider error bodies.

## Data Source

`GET https://opencode.ai/zen/go/v1/usage` with the Go key as a Bearer token returns
`usage.rolling`, `usage.weekly`, and `usage.monthly`. Each includes `status`,
`percent`, and `resetsAt`. HTTP 401 rejects the key; HTTP 403 with `EntitlementError`
means that key has no Go subscription.

Verified against [OpenCode's usage handler](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/go/v1/usage.ts)
and [credential schema](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/schema/src/credential.ts)
on September 7, 2026. See the [OpenCode Go documentation](https://opencode.ai/docs/go/)
for current plan rules.
