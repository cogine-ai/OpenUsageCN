# Doubao

Tracks Volcengine Ark Coding Plan and Agent Plan quota. The plugin uses the same signed, read-only Top OpenAPI actions as CodexBar.

## Setup

1. Create a Volcengine Access Key ID and Secret Access Key for an account allowed to read Ark plan usage.
2. In OpenUsageCN Settings, enter both values under Doubao and enable the plugin.
3. Change the region only if your Ark account uses a region other than `cn-beijing`.

If both keys are already available when Doubao first appears, the [one-time startup check](../provider-enablement.md) can enable it automatically. Adding them later requires the manual switch.

The Settings values take precedence over `VOLCENGINE_ACCESS_KEY_ID`, `VOLCENGINE_SECRET_ACCESS_KEY`, and `VOLCENGINE_REGION`. An `ARK_API_KEY` used for model inference is not an AK/SK pair and cannot sign these plan usage requests.

Keys entered in Settings are stored as plaintext in the local provider settings file, which another process running as the same user can read. On Windows, set environment variables before starting the app, then fully exit and restart it.

## Displayed Data

- **Coding Plan 5H, Weekly, Monthly**: Used percentage from the corresponding `GetCodingPlanUsage` quota, with a reset time only when returned.
- **Agent Plan 5H, Weekly, Monthly**: Used against quota from `GetAFPUsage`, shown only when the account has that plan and the API returns a positive quota.

The Agent Plan API documents `Quota` and `Used` as decimal strings. The parser also accepts numeric values seen in CodexBar's response examples.

The plugin never sends a paid model inference request to discover usage. It does not calculate spend from a model price catalog. If neither action returns an active quota, refresh reports an error rather than showing zero usage.

## Endpoints

```text
POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01
POST https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01
Authorization: HMAC-SHA256 <Volcengine V4 signed request>
```

The Coding Plan request is required. The Agent Plan request is additional: if it fails and Coding Plan quota exists, OpenUsageCN keeps the Coding Plan result and logs the Agent Plan failure. The request signature uses the Volcengine `ark` service name, configured region, and UTC time. See [Volcengine Ark authentication](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh) and [Agent Plan usage API](https://docs.volcengine.com/docs/ark/get-afp-usage-api?lang=zh).
