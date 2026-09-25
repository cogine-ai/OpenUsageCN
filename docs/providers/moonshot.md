# Moonshot / Kimi Open Platform

Tracks the account balance of Moonshot's API platform. This is separate from the Kimi Code plugin, which tracks coding-plan limits.

## Setup

1. Choose International or China Mainland in the Moonshot plugin settings, or leave Region on Auto to use `MOONSHOT_REGION` (default: International).
2. Paste an API key issued for that region into its matching key field.
3. Enable Moonshot in Settings.

If a matching regional key is already available when Moonshot first appears, the [one-time startup check](../provider-enablement.md) can enable it automatically. Adding a key later requires the manual switch.

International keys are sent only to `api.moonshot.ai`; China Mainland keys are sent only to `api.moonshot.cn`. The two Settings fields keep saved keys separate. If the selected region has no saved key, the plugin can use `MOONSHOT_API_KEY` when `MOONSHOT_REGION` matches the selected region. An unset `MOONSHOT_REGION` means International.

Keys saved in Settings are stored as plaintext in the app's `providers.json` under your user profile. Other processes running as your user can read this file.

## Displayed Lines

| Line | Meaning |
|---|---|
| Available Balance | Amount currently available for API usage |
| Cash Balance | Cash component, which may be negative |
| Voucher Balance | Voucher component |

International amounts are shown in USD and China Mainland amounts in CNY, as returned by the selected region. The plugin does not convert currencies or estimate model costs. Moonshot does not provide a session or weekly quota through this endpoint.

## Endpoint

```text
GET https://api.moonshot.ai/v1/users/me/balance
GET https://api.moonshot.cn/v1/users/me/balance
Authorization: Bearer <regional_api_key>
```

Only the endpoint for the selected region is requested. A missing or rejected key, failed request, or malformed response produces a visible error. Diagnostic logs contain the HTTP status or invalid field name, without response content.

Moonshot's [China Mainland balance documentation](https://platform.kimi.com/docs/api/balance) and [International balance documentation](https://platform.kimi.ai/docs/api/balance) describe these endpoints, fields, and currencies.
