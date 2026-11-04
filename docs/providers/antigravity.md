# Antigravity

Tracks Gemini, Claude/GPT, and independent Argon quota pools when Antigravity
reports them. Quota percentages describe pool usage, not prompt counts or money.

## Setup

Sign in to Antigravity or `agy`, then enable the plugin. OpenUsageCN can read the
local language server, Antigravity's existing OAuth state, or the exact `agy`
Keychain account. No separate API key is required.

On macOS, the local credential locations are:

- `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb`
- `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
- Keychain service `gemini`, account `antigravity`, for `agy`.

The plugin does not use legacy Gemini CLI credential files. Existing OAuth refresh
behavior remains; this change does not establish that every installed version or
account can access the new quota endpoint. The source tree retains placeholders
for the Antigravity application's Google OAuth client credentials.

## Displayed Quotas

| Line | Pool And Period |
| --- | --- |
| Gemini | Shared Gemini five-hour pool |
| Gemini Weekly | Shared Gemini weekly pool |
| Claude | Claude/GPT five-hour pool |
| Claude Weekly | Claude/GPT weekly pool |
| Argon Weekly | Independently reported Argon weekly pool |

The quota summary's bucket identity determines the pool and period. Five-hour
and weekly values are separate quotas; they are not added together. Reset times
come from the service. Missing or invalid remaining quota is not treated as zero
remaining. An explicitly reported zero remaining quota shows 100% used.

Argon appears only when the service reports a clearly independent weekly bucket.
Disabled, ambiguous, or unsupported Argon buckets do not create a quota line.
A shared Gemini bucket inside an Argon group does not create a duplicate pool.

Antigravity's older model endpoints may instead show **Gemini Pro**, **Gemini
Flash**, and **Claude**. Those responses do not establish a window, so the app
does not label them as five-hour quotas. Models without a valid remaining
fraction are omitted.

## Sources And Errors

When an existing OAuth access token is available, the plugin first reads
`loadCodeAssist` and `retrieveUserQuotaSummary` using that same token. Production
Cloud Code is preferred. The daily endpoint is consulted only when production is
missing usable shared pools. Matching bucket IDs are counted once; production's
valid value wins. The plan and quota are never combined with another local
language server's account.

If the summary endpoint is explicitly unsupported, the existing local-server or
older model endpoint can provide legacy quotas. A failed or malformed summary
is not silently reinterpreted as legacy data. A project subscription refusal is
reported separately from an expired token. Temporary server failures do not
trigger OAuth refresh. Network requests share a bounded refresh budget.

If no credential or local server is available, the app asks you to start
Antigravity or run `agy`. Subscription, invalid response, and request failures
show an error instead of an invented zero quota. Keep the existing account signed
in and retry after checking access in Antigravity.

Google documents [five-hour and weekly plan limits](https://www.antigravity.google/docs/plans).
The private Cloud Code summary protocol is based on the fixed upstream
[quota client](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Antigravity/AntigravityUsageClient.swift)
and [bucket mapper](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Antigravity/AntigravityUsageMapper.swift).
