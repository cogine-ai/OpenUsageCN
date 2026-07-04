# Alibaba Coding Plan

Tracks Alibaba Coding Plan quota.

This plugin supports the API-key path and a manual Cookie path. It does not import browser cookies.

## Setup

### API Key

1. Get an Alibaba Coding Plan compatible API key.
2. Open OpenUsageCN Settings and paste it into `API Key`.
3. Choose the correct `Region`: `International` or `China Mainland`.
4. Enable the Alibaba Coding Plan plugin.

The Settings value is used first. If it is empty, OpenUsageCN tries `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_QWEN_API_KEY`, then `DASHSCOPE_API_KEY`.

### Manual Cookie

1. Open the Alibaba Coding Plan console in a browser.
2. Copy the request Cookie header manually.
3. Set `Source` to `Manual Cookie` and paste it into `Cookie Header`.

Cookie values entered in Settings are stored as plaintext in `~/.openusagecn/providers.json`, protected only by best-effort private file permissions (`0600` on macOS/Linux).

## Displayed Lines

| Line    | Meaning                                  |
|---------|------------------------------------------|
| Session | 5-hour Coding Plan quota used            |
| Weekly  | Weekly Coding Plan quota used            |
| Monthly | Billing-month Coding Plan quota used     |

## Endpoint

API-key mode requests:

```text
POST https://modelstudio.console.alibabacloud.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2
POST https://bailian.console.aliyun.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2
```

Manual Cookie mode requests the console RPC endpoint for the selected region. It requires a valid `sec_token` in the copied Cookie header.

## Errors

| Condition       | Message                                                           |
|-----------------|-------------------------------------------------------------------|
| No API key      | "No Alibaba Coding Plan API key found. Add it in Settings or set ALIBABA_CODING_PLAN_API_KEY." |
| No Cookie       | "No Alibaba Coding Plan cookie found. Add it in Settings or set ALIBABA_CODING_PLAN_COOKIE." |
| Missing token   | "Alibaba Coding Plan cookie missing sec_token. Copy a fresh console Cookie header." |
| 401/403         | "Alibaba Coding Plan API key invalid. Check your API key."        |
| HTTP error      | "Usage request failed (HTTP {status}). Try again later."          |
| Invalid payload | "Alibaba Coding Plan response missing quota data."                |
