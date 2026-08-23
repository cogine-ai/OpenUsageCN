# Provider Accounts Implementation Plan

Status: Companion specification for
[Provider Accounts, Browser Sessions, and Cursor Model Usage](./provider-accounts-browser-sessions-cursor-history.md).

## Delivery Order

1. Low-cost dependency and plan updates.
2. Provider Accounts core and Cursor local connections.
3. Browser Session Broker.
4. Claude Team seat enrichment.
5. Cursor model usage history.

The first slice can release independently. Later slices should remain separate commits or PRs
when practical so account/cache correctness, sidecar packaging, browser identity, and event
pagination are reviewed as distinct risks.

The implementation-ready issue split is tracked in
[Provider Accounts Delivery Epic](./backlog/provider-accounts-epic.md):

1. [Low-Cost Provider Updates](./backlog/01-low-cost-provider-updates.md)
2. [ProviderAccounts Core](./backlog/02-provider-accounts-core.md)
3. [Cursor Local Multi-Account](./backlog/03-cursor-local-multi-account.md)
4. [Browser Session Broker](./backlog/04-browser-session-broker.md)
5. [Claude Team Seat Enrichment](./backlog/05-claude-team-seat-enrichment.md)
6. [Cursor Model Usage History](./backlog/06-cursor-model-usage-history.md)

## Complete Scope Ledger

| Agreed Item | Slice | Production Result | Required Proof |
| --- | --- | --- | --- |
| 1. ccusage 20.0.20 | A | Primary Claude/Codex local-usage runner uses the published pin | Runner and fallback tests |
| 2. Cursor/Codex plan mappings | A | Exact aliases display Pro+ and Pro 5x | Provider mapping tests |
| 3. Claude Team seat labels | A, B, then D | Pure resolver first, metadata-only OAuth identity with accounts, exact seat after bound browser proof | Identity mismatch and packaged browser UAT |
| 4. Provider Accounts and Cursor local multi-account | B | Desktop and CLI identities reconcile into account-scoped state | Store, selection, race, cache, UI, CLI, and Local HTTP tests |
| 5. Chrome/Arc browser accounts | C | Explicit exact-profile binding via sweet-cookie | Protocol, security, signed helper, and real Keychain UAT |
| 6. Cursor model history | E | Per-account model tokens, request count, list-price equivalent, and metered total | Pagination, account isolation, cost, and dashboard UAT |

The ledger is exhaustive for this change. Cross-account aggregation, generic model catalogs,
Windows browser collection, Cursor Grok Bot allowance, and long-range spend dashboards are not
implementation work in these slices.

## Slice A: Low-Cost Updates

Primary files:

- src-tauri/src/plugin_engine/host_api.rs
- scripts/bump-ccusage-version.mjs
- plugins/cursor/plugin.js
- plugins/codex/plugin.js
- plugins/claude/plugin.js
- Matching Rust and plugin tests

Outcome:

- ccusage primary runner is exactly 20.0.20.
- Cursor pro_plus displays Pro+.
- Codex prolite, pro_lite, and pro-lite display Pro 5x.
- Claude seat resolver understands team_standard and team_tier_1.

## Slice B: Provider Accounts and Cursor Local Sources

Primary files:

- src-tauri/Cargo.toml for the HMAC dependency and any extracted native Keychain support.
- New src-tauri/src/provider_accounts/ Module, split by model, store, coordinator, and adapters.
- Claude OAuth profile identity collection through the fixed-origin metadata-only transport; the
  generic plugin HTTP response logger is not used.
- Add and validate the optional accountSupport manifest capability and expose it in PluginMeta.
- Extract reusable native Keychain access and account host calls from the already-large
  host_api.rs instead of duplicating security-command logic.
- Extend runtime.rs with the optional account-aware plugin Seam.
- Update Cursor discovery to return Desktop and CLI independently.
- Add account Tauri commands, TypeScript types, hooks, header selector, Manage Accounts flow, and
  Add Browser Account entry point.
- Route scheduled probes, manual refresh, one-shot CLI, and Local HTTP stale refresh through the
  same coordinator.

Outcome:

- Same/different Cursor identities reconcile correctly.
- Cursor reconciliation retains the full signed subject and rejects a disagreement between the
  local JWT and /api/auth/me instead of guessing an alias.
- Auto and Pinned selection work.
- Successful snapshots are account-scoped.
- Existing provider-level consumers still receive the active projection.
- Credential refresh uses generation-checked compare-and-swap.
- Account switches never relabel or publish another account's cached output.
- A new explicitly attached browser account becomes Pinned; a connection that matches an existing
  account does not change selection.
- Detaching a browser connection preserves the now-stale account data rather than deleting it.
- Verified Claude email and organization identity is available for later browser membership
  matching without being displayed or persisted raw.

Keep each new source file below roughly 500 lines. Do not add adjacent provider abstractions that
the account Module does not need.

## Slice C: Browser Broker

Primary files:

- package.json and bun.lock with @steipete/sweet-cookie exactly 0.4.1.
- packageManager and CI workflows pinned to the reviewed Bun compiler version.
- tools/cookie-helper source.
- scripts/build-cookie-helper.mjs.
- New src-tauri/src/browser_sessions/ Module.
- src-tauri/tauri.macos.conf.json.
- Backend-only tauri-plugin-shell setup.
- .gitignore entries for target-suffixed generated binaries.
- THIRD_PARTY_NOTICES.md and bundled notice.

Outcome:

- Explicit Chrome/Arc profile discovery.
- Memory-only candidate roster.
- Exact-profile persistent binding with no stored cookie.
- All Profiles discovery expands to bounded independent profile reads.
- Cursor candidates remain isolated by profile, store, and host, with auth-only fallback.
- Signed target-specific sidecar in macOS packages.

## Slice D: Claude Seat Enrichment

Primary files:

- plugins/claude/plugin.js.
- Claude account-aware Adapter and browser request path.
- Resolver, OAuth profile, membership-match, and redaction tests.

Outcome:

- Exact Team Standard or Team Premium label only when verified OAuth email and organization match
  the bound browser account membership.
- Generic Team remains the visible fallback for every incomplete or mismatched case.

## Slice E: Cursor History

Primary files:

- New src-tauri/src/cursor_history/ fetcher, aggregator, scheduler, and store.
- Dedicated fixed-origin native transport and scripted test Adapter.
- POST /api/dashboard/get-filtered-usage-events request and /api/auth/me ownership validation.
- Account-aware history commands/events and TypeScript types.
- Cursor Model Usage detail section.
- Pagination, cost-coverage, account-generation, redaction, and UI-state tests.

Outcome:

- Current-period model tokens and list-price equivalent.
- Separate whole-window metered total when complete.
- No raw events and no cross-account history publication.

## Data Migration and Rollback

- provider-accounts.json, provider-account-snapshots.json, and provider-history/ are additive
  schema-version-1 stores. Existing usage-api-cache.json remains version 1.
- Existing provider cache data is displayed but never guessed into an account. The first verified
  probe seeds the matching account snapshot.
- Account-store corruption or Keychain-key loss fails visibly and leaves the active v1 projection
  readable. It never regenerates a conflicting key or rewrites the old cache.
- Downgrading leaves the new files unused by the previous version. No destructive migration,
  cleanup script, feature flag, or compatibility shim is required.
- Browser support is macOS-configured. Windows builds and their existing supported plugins remain
  unchanged and must continue to compile and package.

## Documentation Required During Implementation

- docs/plugins/api.md
- docs/plugins/schema.md
- docs/app-state-architecture.md
- docs/local-http-api.md
- docs/providers/cursor.md
- docs/providers/codex.md
- docs/providers/claude.md
- docs/release.md
- README.md, because Cursor and Claude support details change even though the provider list does not
- THIRD_PARTY_NOTICES.md

Keep these user documents concise and behavior-focused. Internal Module design remains in these
design specifications.

## Change Gates

Every plugin change audits request and response fields against
src-tauri/src/plugin_engine/host_api.rs redaction and adds gap tests.

Any visual-change PR includes before and after screenshots. Browser/helper slices cannot ship
from source tests alone; they require the signed packaged UAT in the verification plan.

## Definition of Done

The six-item work is complete only when:

1. Every ledger row above is implemented with its targeted automated tests.
2. Existing provider-level overview, tray, notifications, CLI, Local HTTP API, cache, scheduled
   refresh, and manual refresh all project the same active account.
3. No secret or raw identity appears in plugin output, Tauri events, logs, stores, errors, or crash
   reports; plugin request/response redaction tests cover every new field.
4. macOS helpers for both architectures are built, signed, notarized, included in updater
   artifacts, and measured for size.
5. Real Chrome, Arc, Keychain, Claude membership, Cursor multi-account, and Cursor dashboard UAT
   passes on the signed installed app.
6. Required user documentation, README support notes, third-party notices, and before/after UI
   screenshots are present before a PR is created.
7. Release evidence distinguishes Static, Compiled, Packaged, Live UAT, and Released status; a
   green source test never substitutes for a later layer.
