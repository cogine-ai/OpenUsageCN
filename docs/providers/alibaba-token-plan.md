# Alibaba Token Plan

Tracks Alibaba Token Plan quota from the Bailian console.

This plugin uses a manually copied Cookie header. It does not import browser cookies.

## Setup

1. Open the Alibaba Bailian Token Plan console in a browser.
2. Copy the request Cookie header manually.
3. Open OpenUsageCN Settings and paste it into `Cookie Header`.
4. Enable the Alibaba Token Plan plugin.

The Settings value is used first. If it is empty, `ALIBABA_TOKEN_PLAN_COOKIE` is used.

Cookie values entered in Settings are stored as plaintext in `~/.openusagecn/providers.json`, protected only by best-effort private file permissions (`0600` on macOS/Linux).

## Displayed Lines

| Line        | Meaning                              |
|-------------|--------------------------------------|
| Token Quota | Used token quota against total quota |
| Remaining   | Remaining token quota                |
| Expires     | Nearest expiration date, when present |

## Endpoint

The plugin requests:

```text
POST https://bailian.console.aliyun.com/data/api.json?action=GetSubscriptionSummary&product=BssOpenAPI-V3&_tag=
```

The request body includes `ProductCode=sfm_tokenplanteams_dp_cn`, matching the Bailian Token Plan subscription summary request.

## Errors

| Condition       | Message                                                         |
|-----------------|-----------------------------------------------------------------|
| No Cookie       | "No Alibaba Token Plan cookie found. Add it in Settings or set ALIBABA_TOKEN_PLAN_COOKIE." |
| 401/403         | "Alibaba Token Plan login expired. Copy a fresh console Cookie header." |
| HTTP error      | "Usage request failed (HTTP {status}). Try again later."        |
| Invalid payload | "Alibaba Token Plan response missing quota data."               |
