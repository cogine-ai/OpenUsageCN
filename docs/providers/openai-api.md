# OpenAI API

Tracks OpenAI Platform API spend and usage for your organization.

OpenAI API is included in the Windows MVP and is disabled until you configure and enable it.

This is for the OpenAI API platform, not ChatGPT subscription quota and not Codex app quota.

## Setup

1. Create an OpenAI Admin API key with organization usage access.
2. Open OpenUsageCN Settings and paste it into the OpenAI API `Admin API Key` field.
3. Optionally set `Project ID` if you want to scope the query to one project.
4. Enable the OpenAI API plugin.

The Settings value is used first. If it is empty, `OPENAI_ADMIN_KEY` is used, then `OPENAI_API_KEY`.
`OPENAI_PROJECT_ID` is supported for the optional project scope.

API keys entered in Settings are stored as plaintext. macOS uses `~/.openusagecn/providers.json`; Windows uses `%LOCALAPPDATA%\ai.cogine.openusagecn\providers.json`. The file is limited by normal user-profile permissions, but another process running as the same user can read it.

On Windows, environment fallbacks must be present before the app starts. Set them for your user and fully exit and restart OpenUsageCN; a PowerShell `$env:` value is visible only when the app is launched from that terminal session.

## Displayed Lines

| Line          | Meaning                                      |
|---------------|----------------------------------------------|
| 7D Spend      | Last 7 days of organization API cost         |
| Requests      | Last 7 days of completions API requests      |
| Tokens        | Last 7 days of input plus output tokens      |
| Cached Tokens | Cached input tokens, when returned           |
| Credits       | Legacy credit-grants fallback, when present  |
| Balance       | Spendable credits from `total_available` (legacy fallback) |

## Endpoint

The plugin requests the OpenAI Admin API:

```text
GET https://api.openai.com/v1/organization/costs
GET https://api.openai.com/v1/organization/usage/completions
Authorization: Bearer <api_key>
```

If the admin endpoints reject the key and no project scope is configured, it tries the legacy credit-grants endpoint.

## Errors

| Condition     | Message                                                         |
|---------------|-----------------------------------------------------------------|
| No API key    | "No OpenAI API key found. Add an Admin API key in Settings or set OPENAI_ADMIN_KEY." |
| 401/403       | "OpenAI API key invalid. Check your OpenAI API key."            |
| HTTP error    | "Usage request failed (HTTP {status}). Try again later."        |
| Network error | "Usage request failed. Check your connection."                  |
| Invalid JSON  | "Usage response invalid. Try again later."                      |
