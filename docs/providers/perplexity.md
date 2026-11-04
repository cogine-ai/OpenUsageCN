# Perplexity

> Keeps the existing macOS Desktop API credits and adds an explicitly selected website subscription source.

## Overview

- **Protocol:** HTTPS (JSON)
- **Auth:** Bearer token extracted from local Perplexity app cache request object
- **Data sources:**
  - `Cache.db` (local CFNetwork cache) for token + app headers
  - REST API for balance + usage analytics

## Choose A Source

**Desktop API** remains the default and uses the existing local session below. Its API credits are separate from website subscription credits. Select **Web Subscription** explicitly to see personal and organization subscription pools; a failed website request never falls back to the desktop account.

For Web Subscription, sign in at [Perplexity usage](https://www.perplexity.ai/account/usage), copy the complete `Cookie` request header from a signed-in website request, and paste it into **Settings → Perplexity → Cookie Header**. Recognized Auth.js and NextAuth session cookies are supported, including contiguous numbered chunks. Incomplete or ambiguous chunks are rejected before a request is sent. Automatic browser import is not used.

The Cookie uses the app's existing local `providers.json` storage, which is not encrypted at rest. Another process running as the same user can read that file.

## Desktop Local Session (Required For Desktop API)

1. Install the Perplexity macOS app.
2. Open the app and sign in once.

The plugin checks for the Perplexity cache DB at:

- `~/Library/Containers/ai.perplexity.mac/Data/Library/Caches/ai.perplexity.mac/Cache.db`
- fallback: `~/Library/Caches/ai.perplexity.mac/Cache.db`

It reads the cached request object for:

- `https://www.perplexity.ai/api/user`

Then extracts the cached request's `Authorization: Bearer ...` token (and app-like headers).

If no local session is found, the plugin throws:

- `Not logged in. Sign in via Perplexity app.`

## Balance + Usage (No Env Vars)

When a bearer token is present in the cache DB, the plugin calls:

- `GET https://www.perplexity.ai/rest/pplx-api/v2/groups` (resolve `<api_org_id>`)
- `GET https://www.perplexity.ai/rest/pplx-api/v2/groups/<api_org_id>` (read `customerInfo.balance`)
- `GET https://www.perplexity.ai/rest/pplx-api/v2/groups/<api_org_id>/usage-analytics` (sum `cost`)

## Output

- **Plan**: `Pro` when `customerInfo.is_pro === true`
- **Usage** (single progress bar line):
  - `limit = customerInfo.balance`
  - `used = sum(usage-analytics[].meter_event_summaries[].cost)`
  - `resetsAt` not set (UI shows `$<limit> limit`, no reset countdown)

## Limitations

- Cache format is app-version dependent and may change.
- The REST endpoints used are not a public usage API (may change or break without notice).
- Some REST endpoints may be protected by Cloudflare; the plugin sends app-like headers from the cached request object, but may still be blocked (usage will be unavailable).

## Web Subscription Credits

The website source reads `GET https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default` using only the configured session Cookie.

- **Subscription Credits**, **Purchased Credits** and **Promotional Credits** keep their own pools. The service applies usage to recurring credits, then purchased credits, then active promotional credits. Purchased allowance fields are not added twice, and expired promotional grants are excluded.
- Credits retain the endpoint's numeric credit unit. They are not converted to dollars or mixed with the desktop API balance.
- **Organization Credits** shows the returned organization draws against draws plus available organization credits. Available organization credits are the account's total available balance minus the remaining personal pools, or zero when the organization pool is marked depleted.
- **Member Cap Remaining** shows the member's remaining allowance. It is not the organization's available balance.
- Recurring resets and promotional expirations use their own returned timestamps. Empty pools show text instead of a fabricated zero-limit progress bar.

A 401 means the website session expired. A 403 means access was denied; check website access or account permissions. Parse errors and other failures use friendly messages, log no raw credit response or Cookie, and do not switch to Desktop API.

The website billing endpoint is not a documented public usage API and may change. Protocol reference: [CodexBar's fixed subscription credit implementation](https://github.com/steipete/CodexBar/blob/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/Sources/CodexBarCore/Resources/Plugins/perplexity.js).
