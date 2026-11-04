# OpenRouter

Tracks API key quotas, management-key spending, and optional server Activity reports.
The plugin is disabled until you configure and enable it.

## Setup

1. Add your ordinary or management key to `API Key` in Settings.
2. Enable OpenRouter.
3. Open provider details to load **Server Reports** when needed.

The Settings key takes priority over `OPENROUTER_API_KEY`. No second key is needed:
OpenUsageCN reads the key type from OpenRouter. Management keys can read key lists
and Activity; ordinary inference keys cannot.

`API URL` or `OPENROUTER_API_URL` can select an HTTPS-compatible gateway. Custom
hosts, ports, and base paths are supported. The URL cannot contain embedded
credentials, query parameters, or fragments. A missing scheme becomes `https://`.
`OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE` are passed through when present.

For environment settings on Windows, fully exit and restart the app after setting
user environment variables. Terminal-only variables apply only to apps launched
from that terminal.

## Quotas And Spending

Ordinary keys keep the existing **Key Limit**, **Daily Spend**, **Weekly Spend**,
and **Monthly Spend** lines. Key Limit uses remaining quota for the current
window, including BYOK only when OpenRouter counts it toward that limit. Lifetime
usage is not compared with a resettable daily, weekly, or monthly limit. Negative
remaining quota can show spending above the limit.

An all-time key that omits remaining quota can use lifetime usage. Its BYOK usage
is included only when the key explicitly counts BYOK toward the limit. Invalid
quota counters cause a refresh error and preserve the previous successful reading.

Management keys show **Listed Keys Daily Spend**, **Listed Keys Weekly Spend**,
and **Listed Keys Monthly Spend**. Disabled and expired keys are included because
their past spending still counts. A partial or failed page is an error; it is not
shown as a complete total. **BYOK Daily Spend**, **BYOK Weekly Spend**, and
**BYOK Monthly Spend** are separate values, when all listed keys supply them.

**Key Scope** identifies the key-list scope. For an organization management key,
the list defaults to the default workspace; a workspace management key can list
only its own workspace. Listed Keys Spend is not advertised as an account-wide total.

**Credits** and **Balance** describe the account credits returned by OpenRouter.
They are separate from a key's budget. A workspace management key may lack balance
permission. In that case, key spending stays visible and **Balance Status** says
**Balance Unavailable**; the app does not assume a zero balance.

On macOS, the menu bar uses a valid Key Limit first, otherwise an available Balance,
including `$0.00`. Lifetime Credits do not become a menu-bar percentage. See
[Menu Bar Display](../menu-bar.md).

## Server Reports

Activity loads separately from quota refresh and requires a management key. It
covers the last 30 completed UTC days, ending yesterday. **Activity Scope** states
whether the report covers an account or a workspace. A validated workspace ID
returned by OpenRouter limits the request to that workspace. Without one, Activity
uses OpenRouter's account-level response. It never replaces Listed Keys Spend.

Reports show daily platform spending, requests, tokens, model totals, and separate
BYOK spending when supplied. Tokens are prompt plus completion tokens; cached and
reasoning tokens are already included and are not added again.

Only reported dates appear in the chart. Missing dates are listed as missing,
not assumed to have zero spending. An empty response, incomplete coverage,
permission refusal, expired key, rate limit, or request error has its own report
status. Activity failure does not remove the main quota reading.

Reports are fetched on demand and are not added to local model-history storage.
Connection changes invalidate an in-flight report. Raw keys and server identity
fields are not returned to the report interface.

## Read-Only Requests

The plugin reads `/api/v1/key` and `/api/v1/credits`. Management-key quota refresh
also pages through `/api/v1/keys?include_disabled=true&include_expired=true&offset=…`.
Server Reports read `/api/v1/activity`, optionally scoped with `workspace_id`.
Requests share a bounded budget within each refresh. The plugin never creates,
changes, or deletes keys.

See OpenRouter's [key-list protocol](https://openrouter.ai/docs/api/api-reference/api-keys/list-api-keys),
[current-key protocol](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key),
and [Activity protocol](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint).
