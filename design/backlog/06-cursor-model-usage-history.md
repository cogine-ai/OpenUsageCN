# Cursor Model Usage History

## Backlog Ready Spec

### Verdict

READY WITH RISKS

The source, pagination, ownership, token, and cost contracts are fixed. The private Cursor event
ledger and dashboard comparison still require Live UAT before release.

### Source

Brief / issue / roadmap item:

- Add account-scoped Cursor per-model token, request, list-price-equivalent, and metered current
  period history using the event ledger proven by current CodexBar/Reporter code.

Related issues:

- None; the repository has zero issues and no matching issue search result as of 2026-08-24.

Related code:

- New `src-tauri/src/cursor_history/` module
- ProviderAccounts credential leases and Cursor adapter from specs 02 and 03
- BrowserSessionBroker from spec 04
- `src/pages/provider-detail.tsx`, new Cursor-only detail components/hooks/types, and tests
- `src-tauri/src/safe_file.rs`
- `docs/providers/cursor.md` and `docs/app-state-architecture.md`
- [Cursor Model Usage History Design](../cursor-model-usage-history.md)

Current Cursor quota endpoints expose aggregate limits. OpenUsage does not call the dashboard
event ledger, has no account history store, and cannot show per-model token totals.

### User Outcome

On the active Cursor account's detail page, users can see current-period token totals and request
counts by model/date, known list-price equivalent by model, and a separate whole-window metered
total, with explicit coverage and stale/error states.

### Problem

Model token data comes from a paginated event ledger rather than the quota response. Fetching it
inside the 30-second QuickJS probe, globally deduplicating rows without event IDs, or storing it by
provider alone would yield incomplete or cross-account results.

### Scope

In:

- Fetch `POST https://cursor.com/api/dashboard/get-filtered-usage-events` through a dedicated
  fixed-origin native transport.
- Verify `GET https://cursor.com/api/auth/me` resolves to the requested `AccountId` first and use
  the exact accepted cookie candidate for every page.
- Support local Desktop/CLI sessions by deriving `WorkosCursorSessionToken` in memory and browser
  sessions through the broker-held cookie.
- Run account/window/time-zone/generation keyed Rust async jobs outside QuickJS.
- Fetch the current billing cycle capped to the latest 30 days, or 30 days when no reliable cycle
  exists.
- Prove pagination complete before aggregating and committing.
- Aggregate by local date plus raw model into four token classes, checked total tokens, request
  count, list-price equivalent, and coverage.
- Publish a separate whole-window metered total only when every valid timestamped event has valid
  `chargedCents`.
- Persist only complete account-scoped aggregates under `provider-history/provider/account.json`.
- Add a Cursor-only Model Usage section with covered range, refreshed/stale state, token details,
  list-price coverage, and metered total.

Out:

- Raw event persistence, All Accounts totals, or cross-account flattened day/model rows.
- Treating the ledger as a model catalog or adding a local pricing table.
- Claiming list-price equivalent or metered usage is an invoice.
- Filtering or displaying `owningUser`/`owningTeam`.
- 90/365-day selectors or startup history scans.

### Proposed Implementation Direction

Likely files/modules:

- Add `src-tauri/src/cursor_history/` split into fetcher, paginator/mapper, scheduler, store, and
  transport responsibilities, each below roughly 500 lines.
- Add account-aware history Tauri commands/events and nonsecret TypeScript types/hooks.
- Add a Cursor-only detail component rather than extending generic `MetricLine` or overview/tray
  data with history semantics.
- Reuse the ProviderAccounts history operation and safe account store boundary.

Implementation notes:

- Request `pageSize: 1000`; encode `startDate` and `endDate` Unix milliseconds as strings; cap at
  200 pages.
- Require an empty/short final page. A full page at the cap is incomplete.
- If `totalUsageEventsCount` exists, require it to remain stable and require collected count to
  reach it.
- Remove only exact proven overlap at adjacent page boundaries when raw count exceeds the stable
  total. Never globally deduplicate equal events because there is no stable event ID.
- Fail closed on missing page, count drift, unexplained duplicate/overcount, malformed numbers,
  overflow, cancellation, identity change, window/time-zone change, or credential-generation
  change. Preserve the previous complete snapshot.
- Include a row in a model bucket only when timestamp is positive/in-window, `tokenUsage` exists,
  and checked `inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens` is greater than zero.
- Preserve raw model spelling; blank becomes `Unknown` only at presentation.
- `requestCount` counts included token events.
- `tokenUsage.totalCents / 100` is list-price equivalent. Missing values retain known cost with
  Partial coverage; negative/non-finite/overflowing values latch the bucket Invalid for the fetch.
- Sum `chargedCents / 100` across all valid timestamped events, including rows without tokens, only
  when every such row has a finite nonnegative value. Never allocate it to model rows.
- Do not filter, persist, or log `owningUser` or `owningTeam`; label scope `Session-Visible Usage`.
- Trigger on Cursor detail demand, not startup. Allow one job per key, at most two history jobs
  globally, and cancel/supersede older jobs for the same key.
- The native transport logs only endpoint class, status, page, row count, duration, and correlation
  ID. It must not use the generic plugin response-prefix logger.

Reuse existing code:

- Reuse ProviderAccounts `LoadHistory`, account/connection leases, browser SessionRef, safe-file
  replacement, existing provider detail loading patterns, and Cursor current-cycle metadata.

Preserve / do not touch:

- Quota endpoints remain the source of current limits and plan.
- History failure is account-local and cannot clear quota, another account's history, or selection.
- Overview, tray, notifications, CLI, and Local HTTP API v1 remain active quota projections; history
  is detail-only in this release.

### Acceptance Criteria

- [ ] Every history fetch first proves `/api/auth/me` ownership and reuses the exact accepted
  candidate for all pages.
- [ ] Request body, 1,000-row page size, 200-page cap, empty/short final page, stable total, and
  collected-count requirements are covered by tests.
- [ ] Adjacent boundary overlap is removed only when proven; legitimate identical events remain
  separately billable/countable.
- [ ] Missing page, full final page at cap, count drift, unexplained overcount, malformed numeric
  data, overflow, cancellation, account switch, and generation switch commit nothing.
- [ ] Four token classes sum with checked integer arithmetic and remain available in detail.
- [ ] Aggregation is account-scoped by local date and raw model; Chrome/Arc/local accounts using
  the same model never flatten together.
- [ ] Missing `totalCents` marks list cost Partial while preserving known values; invalid cost
  latches Invalid for that bucket.
- [ ] Metered total publishes only when all valid timestamped events have valid `chargedCents` and
  is never allocated to a model.
- [ ] `owningUser`, `owningTeam`, raw events, cookies, subjects, and identity responses never enter
  storage, logs, errors, frontend events, or plugin output.
- [ ] Only complete aggregates replace the prior document; refresh/failure keeps the previous
  complete snapshot visible with explicit refreshing/stale/error state.
- [ ] At most two global jobs run, duplicate keys coalesce/supersede correctly, and detail demand is
  the only automatic trigger.
- [ ] UI labels use titlecase, control icons use `lucide-react`, and values are named
  `List-Price Equivalent`, `Metered Usage`, and `Session-Visible Usage` without invoice claims.
- [ ] New fields are audited against `host_api.rs` redaction with endpoint-specific no-body-log
  tests.
- [ ] `docs/providers/cursor.md`, `docs/app-state-architecture.md`, and README support text describe
  scope, coverage, and active-account ownership.
- [ ] Before/after screenshots cover loading, complete, partial-cost, stale, unavailable, and error
  states before PR creation.

### Validation

Automated:

- Scripted pagination fixtures for short/empty final pages, exact totals, count drift, adjacent
  overlap, legitimate equal events, page cap, missing page, malformed values, and overflow.
- Mapping/cost fixtures for four token classes, unknown model, time zones, Partial/Invalid list
  cost, complete/incomplete metered total, and non-token charged rows.
- Scheduler/store tests for coalescing, global concurrency, cancellation, account/generation/window
  switch, safe replacement, and previous-snapshot retention.
- Browser/local auth candidate and no-secret/redaction tests.
- Frontend Model Usage state/render tests.
- `bun run bundle:plugins`
- `bun run test --run`
- `bun run build`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

Manual:

- Signed installed app: compare one bounded period's per-model tokens/list cost with Cursor
  dashboard and compare the separate metered total when available.
- Run against local and attached browser accounts, including Chrome/Arc accounts that use the same
  model, and verify account isolation.
- Switch account during a later-page fetch and disconnect mid-fetch; verify no stale commit and the
  previous complete snapshot remains.

### Risks And Dependencies

- The Cursor dashboard event endpoint is a private web surface and may change schema/pagination.
- The endpoint has no stable event ID; completeness must remain fail-closed rather than adding a
  heuristic global dedupe.
- Dashboard list-price and metered values have distinct meanings; collapsing them would be a
  product correctness bug.

Required sequence:

- Requires specs 02 and 03. It may be developed beside specs 04/05, but release it after spec 04 so
  browser-only Cursor accounts are covered.

Rollback (only for hard-to-reverse changes):

- History files are additive aggregates. Downgrade ignores them; rollback does not delete them or
  affect quota snapshots.
- Revert the detail section and scheduler together so no background job remains without a reader.

### Open Questions

- None.

### GitHub Issue Body

## Outcome

Add account-scoped Cursor current-period model token, request, list-price-equivalent, and separate
metered usage history from the dashboard event ledger.

## Scope

- Verify account ownership, fetch complete paginated events outside QuickJS, and aggregate by local
  date/model with all four token classes.
- Keep list-price equivalent and whole-window metered usage semantically separate.
- Persist only complete per-account aggregates and preserve the prior complete snapshot on failure.
- Add a Cursor-only detail section; do not add raw events, All Accounts totals, model catalog, or
  Local HTTP history.

## Acceptance Criteria

- [ ] Pagination/completeness, adjacent-overlap, numeric, cost, scheduler, race, and redaction tests
  pass.
- [ ] Equal models across accounts remain isolated and stale results cannot publish after switches.
- [ ] Dashboard comparison UAT, docs, redaction audit, and visual screenshots are complete.

Use `design/backlog/06-cursor-model-usage-history.md` as the full implementation and validation
contract.
