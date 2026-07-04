# OpenRouter

Tracks OpenRouter API credits and key usage.

## Setup

1. Create an OpenRouter API key.
2. Open OpenUsageCN Settings and paste it into the OpenRouter `API Key` field.
3. Enable the OpenRouter plugin.

The Settings value is used first. If it is empty, `OPENROUTER_API_KEY` is used.
`OPENROUTER_API_URL` can override the API base URL, and must use HTTPS.
`OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE` are passed through when present.

API keys entered in Settings are stored as plaintext in `~/.openusagecn/providers.json`, protected only by best-effort private file permissions (`0600` on macOS/Linux).

## Displayed Lines

| Line          | Meaning                                 |
|---------------|-----------------------------------------|
| Credits       | Total used credits against total credits |
| Balance       | Remaining credits                       |
| Key Limit     | Current API key usage against its limit |
| Daily Spend   | Daily key usage, when returned          |
| Weekly Spend  | Weekly key usage, when returned         |
| Monthly Spend | Monthly key usage, when returned        |

## Endpoint

The plugin requests:

```text
GET https://openrouter.ai/api/v1/credits
GET https://openrouter.ai/api/v1/key
Authorization: Bearer <api_key>
```

If one endpoint is unavailable but the other succeeds, OpenUsageCN still shows the available usage data.

## Errors

| Condition     | Message                                                  |
|---------------|----------------------------------------------------------|
| No API key    | "No OpenRouter API key found. Add it in Settings or set OPENROUTER_API_KEY." |
| 401/403       | "OpenRouter API key invalid. Check your OpenRouter API key." |
| HTTP error    | "Usage request failed (HTTP {status}). Try again later." |
| Network error | "Usage request failed. Check your connection."           |
| Invalid JSON  | "Usage response invalid. Try again later."               |
