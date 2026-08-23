# Provider Accounts, Browser Sessions, and Cursor Model Usage

Status: Detailed design complete and ready for implementation. Production code has not been changed.

Last verified: 2026-08-23

## Outcome

The six agreed items are the right scope. Their dependency order needs two constraints:
Claude Team seat labels cannot be made reliable from the current Claude CLI credential alone,
and the OAuth identity response must not pass through the generic plugin HTTP body logger. The
pure label resolver can ship early; OAuth identity collection waits for the ProviderAccounts
metadata-only transport, and exact seat proof waits for the browser session broker.

The agreed six items are:

| Item | Delivery |
| --- | --- |
| 1 | Upgrade ccusage from 20.0.2 to 20.0.20 |
| 2 | Add Cursor pro_plus and Codex pro_lite/pro-lite plan mappings |
| 3 | Add Claude Team seat labels; split into resolver/identity preparation 3a and browser proof 3b |
| 4 | Add Provider Accounts and Cursor Desktop/CLI multi-account support |
| 5 | Add explicit Chrome/Arc profile discovery with sweet-cookie |
| 6 | Add Cursor per-model token and cost history |

The recommended release order is 1/2 plus the pure 3a resolver, then 4 plus OAuth identity
preparation, then 5, then 3b, then 6. Item 6 has a hard dependency only on account-scoped storage
from item 4, so its implementation can proceed beside items 5 and 3b. Releasing it after item 5
also covers browser-only Cursor connections; shipping 3b first gives the broker a smaller
production validation path.

In shorthand, the dependency graph is:

    1 + 2 + 3a resolver
             |
             v
    4 Provider Accounts + Claude OAuth identity
       |              |
       v              v
    5 Browser       6 Cursor History
    Session Broker
       |
       v
    3b Claude

The original item count remains six: the resolver and OAuth identity work are preparation for the
same Claude Team seat-label item, not an additional user-facing feature.

## Verified Baseline

This design was checked against:

| Project | Verified revision or release | Relevant fact |
| --- | --- | --- |
| OpenUsageCN | 04906744301b4490f4114adcb64e46c684369c4a | Current main, 2026-07-31 |
| CodexBar | 4b14ed9c57d3506d1455b2736a1d1a8ff2b9c718 | Current main, 2026-08-23; Cursor code unchanged since the prior snapshot |
| Cogine Reporter | f40c76fe3d81901a1a3ae6e093f0f7776b36a96e | PR #289 merged; Cursor collector 0.3.0 |
| sweet-cookie | 18cc1e0b213dfa31c8d1772d4a5d877ad1710baa | Current main; npm latest is 0.4.1 |
| ccusage | npm 20.0.20 | Published 2026-08-15 |

Current OpenUsage behavior:

- A probe returns one provider-level PluginOutput with one plan and one line list.
- Frontend state, probe generations, and usage-api-cache.json are keyed by provider ID.
- Cursor chooses one credential from Cursor Desktop SQLite or the Cursor CLI Keychain.
- Browser cookies are not read.
- Cursor quota endpoints expose aggregate usage, not per-model token history.
- Claude reads CLI OAuth credentials but does not call the OAuth profile or browser account API.
- QuickJS probes have a 30-second total deadline.
- The generic HTTP host logs a redacted prefix of response bodies, so identity and event-ledger
  endpoints need a stricter metadata-only logging path.

Latest CodexBar confirms two important constraints:

- Cursor model history comes from POST /api/dashboard/get-filtered-usage-events, not from a
  model catalog and not from the quota response.
- Commit 5bc78a2c309b4780cbb78ebd6cabcc601f93c9fc fixed profile-scoped history isolation.
  OpenUsage must establish account ownership before adding history.

CodexBar also added Cursor Grok Bot weekly allowance after the earlier comparison. That is a
separate provider metric and is not folded into this six-item change.

Cogine Reporter proves that explicit Chrome/Arc profiles can be read with sweet-cookie, verified
with /api/auth/me, paged through the Cursor event ledger, and aggregated with all four token
classes. Its final payload intentionally drops account identity and merges equal day/model rows
across accounts. OpenUsage reuses the collection invariants but not that final flattening: every
snapshot, history job, and publication remains owned by one AccountId.

## Scope

This work includes:

- Exact low-cost plan mappings.
- Stable provider account identity and active-account selection.
- Automatic discovery of the one Cursor Desktop and one Cursor CLI credential currently present.
- Explicit, user-triggered Chrome and Arc profile discovery on macOS.
- Per-account successful snapshot caching.
- Claude Team Standard and Claude Team Premium labels when identity matching is proven.
- Cursor current-period per-model tokens, request counts, list-price cost, and metered total.

This work does not include:

- Cross-account aggregate totals.
- Automatic background scans of every browser profile.
- Persisting browser cookies, access tokens, refresh tokens, raw account subjects, or raw emails.
- A public account/history surface in Local HTTP API v1.
- Windows or Linux browser-cookie support.
- Cursor support on Windows.
- A 365-day spend dashboard in the first release.
- Cursor Grok Bot allowance.
- A generic model catalog or local model pricing table.

## Architectural Decision

The chosen design is a provider-first deep Module named ProviderAccounts.

Its common-caller Interface has two operations:

    view(provider_id) -> ProviderAccountView
    perform(provider_id, operation) -> ProviderOperationReceipt

The Module owns identity reconciliation, selection, connection routing, snapshot ownership,
browser bindings, and publication generation checks. Provider-specific Implementations sit
behind a ProviderAccountAdapter Seam.

This gives the design:

- Depth: callers do not implement credential selection or account reconciliation.
- Leverage: one account rule serves the UI, probes, CLI, cache, and future providers.
- Locality: legacy plugins and the existing provider-first frontend remain unchanged.

Two alternatives were rejected:

- A Cursor-only list beside the current probe was too shallow. Account identity and cache
  ownership would leak into unrelated callers and history would still race account switches.
- A fully generic account data plane with cross-account aggregation was too broad for the
  requested work. It would force every provider and every UI surface to adopt account semantics.

## Provider Accounts Core

The Module boundaries, dependency seams, Interface types, operations, UI flow, and persistence
schema are specified in [Provider Accounts Core](./provider-accounts-core.md).

The binding decisions are:

- ProviderAccounts keeps the two-operation view/perform Interface for UI, timer, CLI, and Local
  HTTP callers.
- The Module is implemented in Rust; React receives nonsecret views and QuickJS receives only an
  opaque credential lease.
- Stores, Keychain, sidecar execution, and true external provider transports remain internal seams
  with production and test Adapters.
- Existing probe-result events and PluginOutput stay provider-shaped. Account mutations use a
  separate revision event whose payload contains no identity or locator data.

## Identity and Reconciliation

The hierarchy is:

    ProviderId
      AccountId
        one or more ConnectionId values

A connection is a way to reach an account. It is not itself an account. Cursor Desktop, Cursor
CLI, Chrome, and Arc connections with the same verified Cursor subject merge into one AccountId.

Identity rules:

1. Prefer a provider-issued immutable subject.
2. For Cursor, use the JWT subject and verify browser candidates with /api/auth/me.
3. For Claude enrichment, use the pair of verified email plus exact organization UUID from
   OAuth profile and browser account membership.
4. Never merge two accounts merely because their display email strings look equal.
5. Never merge identities across provider IDs or identity namespaces.

Cursor uses one cursor-sub-v1 identity namespace. Normalize by trimming only; retain the complete,
case-sensitive subject such as auth0|user-id. Splitting the suffix after | is allowed only when
constructing WorkosCursorSessionToken and never for account reconciliation. Desktop and CLI may
claim the signed JWT subject. Browser connections require /api/auth/me. When a local credential
also reaches /api/auth/me, its returned sub must exactly match its JWT subject; a mismatch is an
IdentityChanged error, not an alias or merge. Browser attachment never falls back to email.

OpenUsage persists only:

    HMAC-SHA256(
      installationKey,
      version + providerId + identityNamespace + normalizedIdentity
    )

The 256-bit installation key lives in macOS Keychain under an OpenUsage-owned service. Raw
identity values exist only during reconciliation in the backend process. The registry stores
the HMAC fingerprint and a random AccountId.

If a registry already exists but the Keychain key cannot be read, the Module does not generate
a replacement key or duplicate every account. It reports that account data is unavailable,
keeps the last active provider snapshot displayable, and asks the user to restore Keychain
access. A new key is generated only when no registry exists.

## Selection and Connection Routing

Auto mode preserves today's provider behavior. For Cursor it follows the adapter's current
Desktop/CLI preference rule. Pinned mode remains on the selected AccountId.

SelectActive always changes the selection to Pinned. If that account has a successful cached
snapshot, the UI may show only that account's snapshot while refreshing it. If it has no snapshot,
the UI shows loading; it must never relabel the previous account's output as the new account.
A failed pinned refresh leaves the selection unchanged and does not fall back to another account.

AttachBrowserCandidate behaves deterministically:

- If the verified subject matches an existing account, add the connection without changing the
  current selection.
- If it creates a new account, pin the new account because adding it was an explicit user action.
- Detaching a browser connection never deletes an account, snapshot, or history automatically.
  A browser-only account with no remaining connection stays visible as stale and can be restored
  by attaching the same verified identity later.

If a pinned source signs into a different user:

- The old account becomes unavailable or stale.
- The new identity is reconciled as another account.
- OpenUsage shows a friendly identity-changed message.
- OpenUsage does not silently switch the pinned account.

An account can have several connections with different capabilities. The adapter selects a
connection per operation rather than declaring one connection globally active. For example,
Claude OAuth can provide quota and identity while a verified browser connection provides the
seat tier. Routing is deterministic and recorded in debug metadata without credential values.

Every operation receives one immutable CredentialLease containing:

- ConnectionId and AccountId.
- Credential-source generation fingerprint.
- Allowed capabilities and provider origins.
- Expiry and cancellation state.

Identity and usage must come from the same lease. Before publishing output, writing refreshed
credentials, or committing history, the coordinator verifies that the lease still belongs to
the selected account and current generation.

Cursor token refresh writes must become compare-and-swap operations. SQLite or Keychain is
updated only if the original credential generation and identity still match. A concurrent login
change fails visibly instead of overwriting another account's token.

## Plugin Runtime Seam

Legacy plugins keep exporting:

    probe(ctx)

They run through a LegacyProviderAdapter and appear as one implicit account only inside the
backend. Their PluginOutput, frontend state, and cache behavior do not change.

An account-aware plugin may additionally export:

    discoverConnections(ctx)
    probe(ctx, connectionTarget)

Its manifest declares the UI-visible capabilities:

    accountSupport {
      localDiscovery
      browserBinding
      modelHistory
    }

All fields are optional booleans defaulting to false. The manifest loader validates the shape;
the runtime requires a discoverConnections export when localDiscovery is true. browserBinding
and modelHistory advertise host-owned capabilities and grant no arbitrary browser or network access.

The Cursor plugin uses discoverConnections to inspect Cursor Desktop and Cursor CLI separately.
It must not apply today's choose-one heuristic during discovery.

The runtime adds a scoped identity-claim host call. A plugin submits a provider identity to the
host and receives a runtime-local reference. Rust immediately normalizes and HMACs the claim;
the raw identity is never returned as plugin output or logged. Connection observations refer to
the runtime-local reference.

For a probe, connectionTarget contains only a source kind and an opaque lease reference.
Desktop/CLI credential access is limited to that exact source. Browser requests go through the
BrowserSessionBroker, which injects the cookie only for allowlisted origins.

Local connection discovery and active quota probes retain the 30-second QuickJS deadline.
Cursor history does not run in QuickJS.

## Cursor Automatic Multi-Account Flow

On Cursor refresh:

1. Read Cursor Desktop state.vscdb once from a SQLite snapshot.
2. Read Cursor CLI Keychain credentials once.
3. Classify each source as Observed, Absent, or Unavailable; unreadable is not the same as absent.
4. Decode its JWT subject without logging token contents.
5. Reconcile both observations with the persisted HMAC index.
6. Merge them if the subject matches; otherwise keep two accounts.
7. Resolve Auto or Pinned selection.
8. Probe only the active account for the provider-level output.
9. Verify the lease generation before publication and cache writes.

An Unavailable source keeps its previous connection stale and produces a visible partial-refresh
warning. Only a proven Absent source can mark that connection absent. DetachBrowserConnection
applies only to user-bound browser locators; automatic Desktop/CLI sources cannot be hidden and
will be observed again while their credentials exist.

This automatically supports at most the accounts currently exposed by the Desktop and CLI
credential slots. It does not invent a historical roster. Additional simultaneous accounts
come from explicitly bound browser profiles.

## Browser Session Broker

The detailed protocol, profile grouping, secret-handling rules, sidecar packaging, and size
tradeoff are specified in
[Browser Session Broker](./browser-session-broker.md).

The binding decisions are:

- Discovery starts only after an explicit Add Browser Account action.
- The initial browsers are Chrome and Arc on macOS.
- A normal refresh reads only an already-bound exact profile.
- Explicit All Profiles discovery expands to independent exact-profile reads; it never produces
  one combined Cookie request or a persisted all-profiles locator.
- Unselected candidates are memory-only and expire after ten minutes.
- sweet-cookie is pinned to exactly 0.4.1 and used through a custom compiled helper.
- Cursor Cookie candidates are isolated by browser, profile, store, and normalized host. Cookie
  names are never deduplicated across hosts or profiles.
- Cursor validates cursor.com first, then isolated www.cursor.com, cursor.sh, and
  authenticator.cursor.sh candidates only after a typed authentication rejection. Network,
  timeout, invalid JSON, and HTTP 5xx failures do not trigger candidate switching.
- Browser Cookie reads have a 15-second per-profile deadline. Explicit all-profile discovery has
  a 60-second operation deadline and at most six concurrent profile reads.
- Provider requests use fixed HTTPS origins, matching Origin headers where required, a 30-second
  request deadline, and redirect rejection.
- Raw cookies stay inside the helper and Rust broker; only scoped SessionRef values reach callers.
- The main window receives no shell capability.

The first Safe Storage access is permitted only from the foreground Add Browser Account flow.
A scheduled or launch-time refresh may read an already-bound profile only after a successful
foreground verification has established that binding.

## Claude Team Seat Labels

### Phase 3a: Resolver and OAuth Identity Preparation

Add exact mappings:

| Raw value | Display label |
| --- | --- |
| team_standard | Claude Team Standard |
| team_tier_1 | Claude Team Premium |

The current Claude credential does not contain seat_tier. The pure resolver lands with the
low-cost mappings. After ProviderAccounts exists, its Claude Adapter calls
https://api.anthropic.com/api/oauth/profile using the existing OAuth access token through the
dedicated fixed-origin metadata-only transport. It parses only verified emailAddress and
organizationUuid for backend identity reconciliation. The generic plugin HTTP path is forbidden
for this endpoint because it logs a response prefix. Do not display or persist the raw response.

This phase establishes identity but does not claim a specific Team seat without browser proof.
Existing generic Claude Team remains the fallback.

### Phase 3b: Bound Browser Enrichment

For a user-bound Claude profile:

1. Read that exact profile's claude.ai sessionKey through the broker.
2. GET https://claude.ai/api/account through the broker's allowlisted request path.
3. Find the membership whose organization UUID exactly matches the OAuth profile UUID.
4. Require the normalized verified browser email to match the verified OAuth email. Normalize by
   trimming surrounding ASCII whitespace and ASCII-lowercasing only; do not apply dot, plus-tag,
   Unicode, or provider-alias normalization.
5. Read that membership's seat_tier and apply the resolver.

If either identity field is absent, the organization does not match, the browser session belongs
to another account, or seat_tier is unknown, keep Claude Team. Log a redacted reason and do not
guess. In this scope, the Claude browser connection enriches an OAuth account; it does not create
a standalone browser-only Claude account.

## Cursor Plan Labels

Add provider-local normalization and tests:

| Provider | Raw value | Display label |
| --- | --- | --- |
| Cursor | pro_plus | Pro+ |
| Codex | prolite | Pro 5x |
| Codex | pro_lite | Pro 5x |
| Codex | pro-lite | Pro 5x |

Unknown values keep the current readable fallback. These mappings do not introduce a shared
model catalog or a global plan taxonomy.

## ccusage Upgrade

Change the pinned primary runner from ccusage@20.0.2 to ccusage@20.0.20. Keep the existing
release-age fallback at 18.0.11.

The implementation must update:

- The Rust version constant.
- Rust test literals and runner assertions.
- docs/plugins/api.md.
- The bump script, or its validation, so future bumps cannot leave test literals stale.

Run the targeted host API tests for runner choice, arguments, release-age fallback, and response
normalization. A package metadata check alone is not sufficient.

## Cursor Per-Model Token and Cost History

The endpoint contract, pagination proof, aggregate schema, cost semantics, scheduler, and UI
states are specified in
[Cursor Model Usage History](./cursor-model-usage-history.md).

The binding decisions are:

- Use the authenticated event ledger, not quota responses or a local model catalog.
- Sum input, output, cache-write, and cache-read tokens with checked arithmetic.
- Authenticate the exact Cookie candidate with /api/auth/me and use that same candidate for every
  page. Only a typed 401/403 or missing-sub rejection may select another isolated candidate.
- Run outside the 30-second QuickJS probe and only on Cursor detail demand.
- Scope every job and cache entry to AccountId, credential generation, window, and time zone.
- Publish only a complete page range and retain the last complete snapshot on failure.
- Keep per-model list-price cost separate from the whole-window metered charge.
- A failed history job affects only its AccountId and never suppresses another account's cache or
  active provider snapshot.
- Do not implement an All Accounts aggregate.

## Logging and Security

- Use a dedicated metadata-only Rust transport for browser identity and Cursor history.
- Do not route these response bodies through the current generic 500-byte body logger.
- Log status code, endpoint class, page number, counts, duration, and correlation ID only.
- Audit every new plugin request/response field against host_api.rs redaction.
- Add tests proving cookies, bearer tokens, session keys, subjects, emails, owningUser, and
  owningTeam do not appear in logs, operation receipts, events, caches, or crash-safe errors.
- Bound all sidecar output, request bodies, page counts, concurrency, and deadlines.
- Allow only HTTPS and fixed provider origins.
- Never pass a user-controlled executable path or arbitrary sidecar arguments.
- Keep browser candidates and CredentialLease values in memory with explicit expiry.

## Implementation Slices

The file-level slices, documentation list, and commit boundaries are specified in
[Implementation Plan](./provider-accounts-implementation-plan.md).

Each slice is independently testable and keeps the provider-first compatibility projection.
The account foundation lands before either browser identity enrichment or Cursor history.

## Verification Gates

The full unit, integration, packaging, signing, and installed-app acceptance matrix is specified
in [Verification Plan](./provider-accounts-verification-plan.md).

Static source tests, helper compilation, packaged smoke, and live provider comparison are
separate evidence layers. Browser and history support are not verified until the signed installed
build passes the real Chrome, Arc, Keychain, account-switch, and Cursor dashboard checks.

## Source References

- CodexBar: https://github.com/steipete/CodexBar
- Cursor history introduction: https://github.com/steipete/CodexBar/commit/603dbdf9ce474c190b43c75123b4cb2d167c2093
- Cursor history account isolation: https://github.com/steipete/CodexBar/commit/5bc78a2c309b4780cbb78ebd6cabcc601f93c9fc
- Cursor cost correctness: https://github.com/steipete/CodexBar/commit/0425dde33b4142e76aeedd36c7e8bc2553811273
- Cursor invalid-cost latch: https://github.com/steipete/CodexBar/commit/f6395d05b66327a4ee48321390f5c098c13f5678
- Cogine Reporter Cursor implementation: https://github.com/cogine-ai/Cogine-Teams/pull/289
- sweet-cookie: https://github.com/steipete/sweet-cookie
- sweet-cookie usage: https://github.com/steipete/sweet-cookie/blob/main/docs/usage.md
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Bun compiled executables: https://bun.sh/docs/bundler/executables
