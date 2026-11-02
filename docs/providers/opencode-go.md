# OpenCode Go

OpenCode Go shows your account-wide subscription usage from OpenCode's usage API,
including usage from other devices and clients. Local conversation history is not
used to estimate your remaining account quota.

## Setup

Sign in to OpenCode Go in OpenCode as usual. OpenUsageCN reuses OpenCode's active
login from the `credential` table in `~/.local/share/opencode/opencode.db`.
An active `opencode-go` login takes priority over an active `opencode` login.
Both API keys and unexpired OAuth access tokens are supported. Multiple active
logins for the selected integration produce an error instead of choosing an account.

Only when the database or credential table does not exist does OpenUsageCN read
the older `auth.json` file's `opencode-go` entry with `type: "api"`. An empty,
unreadable or invalid modern credential store never revives an old login.
Readable storage without an active login is reported as **Not Detected**.

An absolute `XDG_DATA_HOME` changes the data root; relative values use the default
`~/.local/share`. `OPENCODE_DB` selects a database filename under the `opencode`
directory, or an absolute database path. An in-memory database (`:memory:`) cannot
be used by this separate process and is reported as **Not Detected**.

Credentials are read-only. OpenCode remains responsible for refreshing OAuth
tokens and changing the active login. Keys belonging to unrelated providers are
never tried.

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

`GET https://opencode.ai/zen/go/v1/usage` with the selected credential as a Bearer token returns
`usage.rolling`, `usage.weekly`, and `usage.monthly`. Each includes `status`,
`percent`, and `resetsAt`. HTTP 401 rejects the key; HTTP 403 with `EntitlementError`
means that key has no Go subscription.

Verified against [OpenCode's usage handler](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/go/v1/usage.ts)
and [credential schema](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/schema/src/credential.ts)
on September 7, 2026. See the [OpenCode Go documentation](https://opencode.ai/docs/go/)
for current plan rules.

Active-login selection follows CodexBar's [CLI credential reader](https://github.com/steipete/CodexBar/blob/0179d0e11300226f4c33130d878c243dc1dbcb4b/Sources/CodexBarCore/Providers/OpenCodeGo/OpenCodeGoLocalUsageReader.swift),
including modern-store precedence and the shared OpenCode login.
