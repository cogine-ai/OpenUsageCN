# OpenRouter

Tracks OpenRouter API credits and key usage.

OpenRouter is included in the Windows MVP and is disabled until you configure and enable it.

## Setup

1. Create an OpenRouter API key.
2. Open OpenUsageCN Settings and paste it into the OpenRouter `API Key` field.
3. Enable the OpenRouter plugin.

The Settings value is used first. If it is empty, `OPENROUTER_API_KEY` is used.
`OPENROUTER_API_URL` can override the API base URL. Custom hosts, ports, and base paths are supported. The URL must use HTTPS and cannot contain embedded credentials, query parameters, or fragments. OpenUsageCN adds `https://` when the scheme is omitted.
`OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE` are passed through when present.

API keys entered in Settings are stored as plaintext. macOS uses `~/.openusagecn/providers.json`; Windows uses `%LOCALAPPDATA%\ai.cogine.openusagecn\providers.json`. The file is limited by normal user-profile permissions, but another process running as the same user can read it.

On Windows, environment fallbacks must be present before the app starts. Set them for your user and fully exit and restart OpenUsageCN; a PowerShell `$env:` value is visible only when the app is launched from that terminal session.

## Displayed Lines

| Line          | Meaning                                 |
|---------------|-----------------------------------------|
| Credits       | Total used credits against total credits |
| Balance       | Remaining credits                       |
| Key Limit     | Current API key usage against its limit |
| Daily Spend   | Daily key usage, when returned          |
| Weekly Spend  | Weekly key usage, when returned         |
| Monthly Spend | Monthly key usage, when returned        |

On macOS, the menu bar shows the key-limit percentage when the key has a valid limit. Without one, it shows the account Balance, including `$0.00`. Lifetime Credits do not become a menu-bar percentage. See [Menu Bar Display](../menu-bar.md).

Key Limit uses the key's remaining quota, including any BYOK spending counted by
OpenRouter. Lifetime spending is not compared with a daily, weekly, or monthly
limit. A key with a daily limit of $10 and $8 remaining therefore shows $2 used,
even if its lifetime spending is $100. Negative remaining quota is shown as usage
above the limit. If current quota data is invalid or missing, the refresh reports
an error and keeps the previous successful reading.

For an all-time key that omits the remaining field, lifetime usage is used, with
BYOK usage included only when the key explicitly counts it toward the limit.

## Endpoint

The plugin requests:

```text
GET https://openrouter.ai/api/v1/credits
GET https://openrouter.ai/api/v1/key
Authorization: Bearer <api_key>
```

If one endpoint is unavailable but the other succeeds, OpenUsageCN still shows the available usage data.

Diagnostic logs redact the key creator's user ID returned by the
[current-key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).
Quota counters and reset policies remain available for troubleshooting.

## Errors

| Condition     | Message                                                  |
|---------------|----------------------------------------------------------|
| No API key    | "No OpenRouter API key found. Add it in Settings or set OPENROUTER_API_KEY." |
| Invalid API URL | "OpenRouter API URL must be a valid HTTPS base URL without embedded credentials." |
| 401/403       | "OpenRouter API key invalid. Check your OpenRouter API key." |
| HTTP error    | "Usage request failed (HTTP {status}). Try again later." |
| Network error | "Usage request failed. Check your connection."           |
| Invalid JSON  | "Usage response invalid. Try again later."               |
