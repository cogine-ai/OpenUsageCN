# Cursor Model Usage History

Status: Companion specification for
[Provider Accounts, Browser Sessions, and Cursor Model Usage](./provider-accounts-browser-sessions-cursor-history.md).

## Data Source and Authentication

Use:

    POST https://cursor.com/api/dashboard/get-filtered-usage-events

The request uses the active account's Cursor cookie and a matching Origin header. Desktop and
CLI bearer credentials may derive WorkosCursorSessionToken in memory. A browser connection uses
the broker-held cookie. Before fetching, https://cursor.com/api/auth/me must resolve to the
active AccountId.

Browser candidates stay isolated by host. Validate cursor.com first, then www.cursor.com,
cursor.sh, and authenticator.cursor.sh only after a typed 401/403 or missing-sub rejection. A
timeout, redirect, malformed response, network error, or HTTP 5xx fails the operation instead of
selecting another identity. The exact candidate accepted by /api/auth/me is reused for every page.

The endpoint supplies the model name and four token fields:

- inputTokens
- outputTokens
- cacheWriteTokens
- cacheReadTokens

Displayed total tokens are the checked sum of those four values. Model names remain exactly as
the API returns them; an empty name becomes unknown. This is an event ledger, not a model catalog.

Quota endpoints remain the source of current plan limits. The history ledger is a separate,
account-scoped data product.

## Scheduler

History runs as a Rust async job outside the 30-second QuickJS probe:

- Trigger when the Cursor detail page requests current-period history.
- Use the current billing cycle, capped to the most recent 30 days; fall back to 30 days.
- Do not scan at application startup.
- Allow one job per provider/account/window and at most two history jobs globally.
- A newer job supersedes and cancels an older job for the same key.
- Keep the last complete snapshot visible during refresh or failure.

The job key includes ProviderId, AccountId, window, time-zone identifier, and credential
generation. A result publishes only if all still match. Switching accounts cancels the old
detail request but does not delete its last complete account-scoped snapshot.

## Request and Pagination

The JSON body contains:

    {
      page
      pageSize: 1000
      startDate
      endDate
    }

startDate and endDate are Unix milliseconds encoded as strings.

Completeness rules:

- Request 1,000 rows per page, with a hard cap of 200 pages.
- Require an empty or short final page; a full page at the cap is incomplete.
- If totalUsageEventsCount is present, require it to stay constant.
- Require the collected row count to reach the authoritative count.
- If raw rows exceed that count, remove only the exact proven overlap at adjacent page
  boundaries.
- Fail closed on a missing page, count change, unexplained duplicates, malformed numeric values,
  integer overflow, cancellation, or credential switch.
- Preserve the previous complete snapshot when the new window is incomplete.

The endpoint has no stable event ID. Do not globally deduplicate equal events because equal rows
can represent distinct billable requests.

## Mapping

Include an event in a model bucket only when:

- Its timestamp is a positive valid value inside the requested window.
- tokenUsage exists.
- The checked four-field token sum is greater than zero.

Group by local calendar date and the API's raw model string. Record the time-zone identifier in
coverage so a time-zone change triggers re-fetch or re-aggregation.

Persist aggregates only:

    ModelUsageBucket {
      localDate
      modelName
      inputTokens
      outputTokens
      cacheWriteTokens
      cacheReadTokens
      requestCount
      knownListCostUsd?
      listCostCoverage
    }

    HistoryCoverage {
      from
      to
      timeZone
      complete
      scope = SessionVisible
      fetchedAt
    }

    HistoryTotals {
      meteredChargedUsd?
      meteredCoverage
    }

requestCount is the number of included token events.

## Cost Semantics

knownListCostUsd comes from tokenUsage.totalCents and represents vendor list/API-rate equivalent:

- A valid value contributes totalCents divided by 100.
- If a token event omits totalCents, preserve known priced rows and mark coverage Partial.
- A negative, non-finite, or overflowing value marks the affected bucket Invalid.
- Once Invalid, later valid events cannot revive that bucket in the same fetch.

meteredChargedUsd comes from chargedCents:

- Sum it across every valid timestamped event, including events without token details.
- Publish it only when every such event has a finite nonnegative value.
- If any value is absent or invalid, publish no metered total and mark coverage Incomplete.
- It is a whole-window total and must never be allocated to model rows.

The UI labels these values List-Price Equivalent and Metered Usage. It does not call either value
an invoice or promise that the provider bills each model row that way.

## Provider Scope

The response may contain owningUser and owningTeam. OpenUsage:

- Does not filter using those fields.
- Does not persist them.
- Does not include them in logs or error text.
- Does not infer that the response is personal-only or team-wide.

The service decides what the authenticated session can see, so the UI calls the coverage
Session-Visible Usage.

## Storage and Publication

Store one complete aggregate document per ProviderId and AccountId under provider-history.
Never store raw event rows.

Write through safe replacement only after:

1. Pagination proves the range complete.
2. Aggregation passes checked arithmetic.
3. The active CredentialLease still has the same AccountId and generation.
4. The requested window and time zone still match the job key.

A failed refresh leaves the previous complete document untouched. It updates only in-memory
error metadata and the visible stale state.

History failure is account-local. It does not clear another account's history, change active
selection, suppress a successful quota snapshot, or flatten events into an all-account result.
This intentionally differs from Cogine Reporter, which validates several configured accounts and
then merges their events into one day/model payload.

## UI

Provider remains the navigation entity. The overview, tray, notifications, and Local HTTP API
v1 show only the active account projection.

On Cursor detail:

- Show Model Usage as an async Cursor-only section.
- Show total tokens and known list cost per model.
- Show the actual metered current-period total separately.
- Show the exact covered date range and last-updated time.
- Show cached, refreshing, stale, partial-cost, incomplete, and unavailable states explicitly.
- Use titlecase for hardcoded titles and lucide-react for control icons.

The four token classes may appear in a tooltip or expanded detail, while the default row stays
compact. There is no All Accounts option and no 90/365-day selector in this release.

## Logging

Use a dedicated native transport that logs only endpoint class, status, page number, row count,
duration, and correlation ID. Do not use the generic plugin HTTP response-prefix logger.

Redaction tests must prove that cookie values, model event bodies, owningUser, owningTeam, and
account identity do not enter logs or frontend events.
