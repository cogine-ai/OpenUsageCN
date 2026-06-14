# BigModel CN

Tracks BigModel CN usage quotas from the China mainland BigModel endpoint.

BigModel CN and Z.ai are separate providers in OpenUsageCN. Enable this plugin when your plan and API key belong to
`open.bigmodel.cn`. Keep using the Z.ai plugin for `api.z.ai`.

## Setup

1. Get your BigModel API key from the BigModel console.
2. Set `BIGMODEL_API_KEY`.

`ZHIPUAI_API_KEY` is also supported as a fallback. This plugin does not read `ZAI_API_KEY` or `GLM_API_KEY`.

OpenUsageCN is a GUI app. A one-off `export ...` in a terminal session will not be visible when you launch OpenUsageCN
from Spotlight or Launchpad. Persist it, then restart OpenUsageCN.

zsh (`~/.zshrc`):

```bash
export BIGMODEL_API_KEY="YOUR_API_KEY"
```

fish (universal var):

```fish
set -Ux BIGMODEL_API_KEY "YOUR_API_KEY"
```

3. Enable the BigModel CN plugin in OpenUsageCN settings.

## Displayed Lines

| Line         | Meaning                                      |
|--------------|----------------------------------------------|
| Session      | 5-hour token usage, shown as a percentage    |
| Weekly       | Weekly token usage, shown as a percentage    |
| Web Searches | Monthly MCP / web search usage, shown as count |

The plan name is shown when BigModel returns one. Missing plan fields do not stop usage from loading.

## Endpoint

The plugin requests:

```text
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Authorization: Bearer <api_key>
```

## Errors

| Condition     | Message                                                           |
|---------------|-------------------------------------------------------------------|
| No API key    | "No BIGMODEL_API_KEY found. Set up environment variable first."   |
| 401/403       | "API key invalid. Check your BigModel CN API key."                |
| HTTP error    | "Usage request failed (HTTP {status}). Try again later."          |
| Network error | "Usage request failed. Check your connection."                    |
| Invalid JSON  | "Usage response invalid. Try again later."                        |
