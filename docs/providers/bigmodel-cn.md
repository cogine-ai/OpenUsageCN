# BigModel CN

Tracks BigModel CN usage quotas from the China mainland BigModel endpoint.

BigModel CN is included in the Windows MVP and is disabled until you configure and enable it.

BigModel CN and Z.ai are separate providers in OpenUsageCN. Enable this plugin when your plan and API key belong to
`open.bigmodel.cn`. Keep using the Z.ai plugin for `api.z.ai`.

They are separate plugins so users can keep separate global Z.ai and mainland BigModel accounts enabled at the same
time. The quota shape is shared with Z.ai, but environment variables, settings, cache entries, and plugin data folders
remain separate.

## Setup

1. Get your BigModel API key from the BigModel console.
2. Open OpenUsageCN Settings and paste it into the BigModel CN `API Key` field.
3. Enable the BigModel CN plugin in OpenUsageCN settings.

The Settings value is used first. If the field is empty, `BIGMODEL_API_KEY` is supported as an environment fallback.
`ZHIPUAI_API_KEY` is also supported as a second fallback. This plugin does not read `ZAI_API_KEY` or `GLM_API_KEY`.

API keys entered in Settings are stored as plaintext. macOS uses `~/.openusagecn/providers.json`; Windows uses `%LOCALAPPDATA%\ai.cogine.openusagecn\providers.json`. The file is limited by normal user-profile permissions, but another process running as the same user can read it.

If you use environment variables, remember that OpenUsageCN is a GUI app. A one-off `export ...` in a terminal session will not be visible when you launch OpenUsageCN from Spotlight or Launchpad. Persist it, then restart OpenUsageCN.

On Windows, set the variable for your user before launching OpenUsageCN, then fully exit and restart the app. A PowerShell `$env:` value is visible only when OpenUsageCN is launched from that same terminal session.

zsh (`~/.zshrc`):

```bash
export BIGMODEL_API_KEY="YOUR_API_KEY"
```

fish (universal var):

```fish
set -Ux BIGMODEL_API_KEY "YOUR_API_KEY"
```

## Displayed Lines

| Line         | Meaning                                      |
|--------------|----------------------------------------------|
| Session      | 5-hour token usage, shown as a percentage    |
| Weekly       | Weekly token usage, shown as a percentage    |
| Web Searches | Monthly MCP / web search usage, shown as count |

The plan name is best effort. If the quota payload includes `planName`, `plan`, `plan_type`, or `packageName`,
OpenUsageCN shows it. If those fields are missing, usage still loads and the plan label stays blank.

## Endpoint

The plugin requests:

```text
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: Bearer <api_key>
```

Expected quota fields:

- `data.limits[]`
- `TOKENS_LIMIT` with `unit: 3` for the 5-hour Session line
- `TOKENS_LIMIT` with `unit: 6` for the Weekly line
- `TIME_LIMIT` for the monthly Web Searches count
- optional `data.planName`, `data.plan`, `data.plan_type`, or `data.packageName` for the plan label

## Errors

| Condition     | Message                                                           |
|---------------|-------------------------------------------------------------------|
| No API key    | "No BigModel CN API key found. Add it in Settings or set BIGMODEL_API_KEY." |
| 401/403       | "API key invalid. Check your BigModel CN API key."                |
| HTTP error    | "Usage request failed (HTTP {status}). Try again later."          |
| Network error | "Usage request failed. Check your connection."                    |
| Invalid JSON  | "Usage response invalid. Try again later."                        |
