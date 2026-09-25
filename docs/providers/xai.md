# xAI

Tracks xAI API prepaid balance and recent billed usage. This is separate from the Grok consumer subscription shown by the Grok plugin.

## Setup

1. In the xAI Console, create a **Management API key** with billing access. An inference API key cannot read billing data.
2. Find the Team ID for that key.
3. In OpenUsageCN Settings, enter both values under xAI and enable the plugin.

If both values are already available when xAI first appears, the [one-time startup check](../provider-enablement.md) can enable it automatically. Adding them later requires the manual switch.

The Settings values take precedence over `XAI_MANAGEMENT_API_KEY` and `XAI_TEAM_ID` environment variables. The Team ID is used only in the fixed xAI Management API URL.

Keys entered in Settings are stored as plaintext in the local provider settings file, which another process running as the same user can read. On Windows, set environment variables before starting the app, then fully exit and restart it.

## Displayed Data

- **Prepaid Balance** comes from the management billing balance API. Its `total.val` is a signed number of US cents; the plugin reverses the ledger sign and converts cents to dollars.
- **30D Spend** and **Daily Spend** come from the management billing usage API. These are shown only when history succeeds. If the API reports a row limit, the result is marked partial.

The plugin makes read-only billing requests. It does not send inference requests or estimate cost from a model price catalog.

## Endpoints

```text
GET  https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance
POST https://management-api.x.ai/v1/billing/teams/{team_id}/usage
Authorization: Bearer <management_api_key>
```

If usage history fails but the balance succeeds, OpenUsageCN keeps the balance and logs the history failure. Authentication and Team ID failures still stop the refresh. See [xAI Management API](https://docs.x.ai/developers/management-api-guide) and [billing endpoint reference](https://docs.x.ai/developers/rest-api-reference/management/billing).
