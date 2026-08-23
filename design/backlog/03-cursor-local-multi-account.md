# Cursor Local Multi-Account And Active Projection

## Backlog Ready Spec

### Verdict

READY WITH RISKS

The Cursor identity, selection, UI, and projection rules are fixed. Real login-switch and
cross-process races still require installed-app UAT before release.

### Source

Brief / issue / roadmap item:

- Read Cursor Desktop and Cursor CLI independently, reconcile same/different accounts, allow active
  selection, and keep every existing provider consumer on that active account.

Related issues:

- None; the repository has zero issues and no matching issue search result as of 2026-08-24.

Adjacent pull requests:

- PR #182 and PR #204 modify/test cache and stale-probe ownership adjacent to this integration.

Related code:

- `plugins/cursor/plugin.js`, `plugins/cursor/plugin.json`, and `plugins/cursor/plugin.test.js`
- `src-tauri/src/plugin_engine/{manifest.rs,runtime.rs,host_api.rs}`
- `src-tauri/src/{lib.rs,usage_reader.rs,cli.rs,probe_batches.rs}`
- `src-tauri/src/local_http_api/cache.rs`
- `src/lib/plugin-types.ts`, `src/hooks/use-probe-events.ts`
- `src/pages/provider-detail.tsx`, `src/components/provider-card.tsx`, and related tests/stores
- [Provider Accounts Core Design](../provider-accounts-core.md)

Current behavior chooses one auth state: Cursor Desktop SQLite normally wins, except a different
CLI Keychain account can win when SQLite looks Free. The other discovered identity is discarded.

### User Outcome

Without configuring credentials, users see every currently signed-in Cursor Desktop and Cursor
CLI account, can pin one or follow the current default, rename it locally, and receive the same
account's data in the detail page, overview, tray, notifications, CLI, and Local HTTP API.

### Problem

`loadAuthState` collapses two local sources into one before identity ownership exists. A login
change or refresh can therefore replace another account's view or token, and users cannot select
or inspect the retained accounts.

### Scope

In:

- Declare Cursor `accountSupport` and implement its account-aware adapter.
- Discover the Desktop SQLite and Cursor CLI Keychain sources independently on each local
  discovery operation.
- Reconcile each nonblank full JWT subject in the `cursor-sub-v1` namespace.
- Preserve the current Desktop/CLI preference as Cursor's Auto rule without discarding the
  non-active account.
- Route each probe through an immutable account/connection credential lease.
- Make Cursor Desktop token refresh writes compare-and-swap against the original SQLite values and
  identity. Keep scoped CLI Keychain refreshes in memory because Keychain cannot condition writes
  on the old value.
- Add account view/operation hooks and state, an active-account selector in the Cursor detail
  header, and a Manage Accounts flow for local accounts, rename, availability, and selection.
- Publish only the active snapshot to every existing provider-level consumer.
- Surface loading, stale, unavailable, identity-changed, partial discovery, and persistence errors
  distinctly with a correlation ID.
- Keep the Add Browser Account entry point ready for spec 04; do not scan a browser in this issue.

Out:

- Chrome/Arc cookie reads or browser candidate attachment.
- Cross-account totals, a provider list per account, or an account argument in Local HTTP API v1.
- Merging by email, guessed aliases, or persisted raw token subject.
- Cursor model token history.

### Proposed Implementation Direction

Likely files/modules:

- Add a Cursor adapter under the new `src-tauri/src/provider_accounts/` provider adapter boundary.
- Refactor `plugins/cursor/plugin.js` so discovery returns independent connection claims and probing
  accepts only the coordinator-supplied opaque connection target.
- Extend `plugin.json`, manifest tests, `PluginMeta`, frontend account hooks/store, provider detail,
  and focused component/event race tests.
- Route `start_probe_batch`, scheduled probes, `usage_reader`, CLI, cache publication, tray, and
  notification inputs through the ProviderAccounts coordinator.

Implementation notes:

- Normalize Cursor identity by trimming only. Keep full case-sensitive subjects such as
  `auth0|user-id`; split after `|` only when constructing a WorkOS session cookie.
- Desktop/CLI may claim their JWT subject. If a local credential also calls `/api/auth/me`, the
  returned `sub` must match exactly or the connection fails as `IdentityChanged`.
- Never merge by email. Same subjects merge; different subjects always remain distinct.
- Auto retains today's source preference. `SelectActive` pins the chosen account.
- Attaching a new browser identity later will pin it; attaching a future matching connection will
  not change selection. Keep the UI model compatible with these already-decided rules.
- An uncached selection shows loading. A failed pinned refresh stays pinned and keeps only that
  account's last successful snapshot.
- If a pinned source signs into another identity, retain the old account as unavailable/stale,
  create/reconcile the new account separately, and do not switch silently.
- Account labels are user-authored local metadata; technical source names, paths, cookies, and
  subject hints are not shown.

Reuse existing code:

- Reuse current SQLite/Keychain reads, quota/plan requests, provider output rendering, refresh
  cooldown, stale-data UI, probe supersession, and provider-level cache/consumer types.

Preserve / do not touch:

- Preserve single-account Cursor output shape and current quota semantics.
- Keep overview/tray/notifications/CLI/Local HTTP provider-shaped and active-only.
- Do not move raw account data into Zustand, React props, Tauri events, or plugin output.
- Do not add an All Accounts selector or automatic credential configuration.

### Acceptance Criteria

- [ ] Same full Cursor subject in Desktop and CLI yields one account with two local connections.
- [ ] Different Desktop and CLI subjects yield two stable accounts, both visible in Manage
  Accounts, with the existing preference selected in Auto mode.
- [ ] Case changes or removal of the `auth0|` prefix are not treated as the same identity.
- [ ] A JWT subject and `/api/auth/me.sub` disagreement fails as `IdentityChanged` and does not
  create an alias or publish usage.
- [ ] SelectActive pins; FollowDefaultConnection returns to Auto; both survive restart.
- [ ] Selecting an account with no snapshot shows loading and never displays the previous account
  under the new label.
- [ ] A failed pinned refresh preserves selection and the pinned account's prior snapshot without
  falling back.
- [ ] A source login change leaves the old pinned account stale/unavailable and reconciles the new
  identity separately.
- [ ] Refreshed Desktop tokens write only when the source generation and identity remain unchanged;
  scoped CLI refreshes never overwrite Keychain.
- [ ] Detail, overview, tray, notifications, scheduled/manual refresh, CLI, and Local HTTP all
  project the same active account under races and restarts.
- [ ] Rename validation and visible loading/stale/unavailable/partial/error states are covered by UI
  tests; all new hardcoded titles use titlecase and control icons use `lucide-react`.
- [ ] Existing single-account Cursor quota and plan tests remain green.
- [ ] New Cursor request/response fields are audited against `host_api.rs` redaction with gap tests.
- [ ] `docs/providers/cursor.md`, `docs/app-state-architecture.md`, `docs/local-http-api.md`,
  `docs/plugins/schema.md`, and README support text describe the shipped behavior.
- [ ] Before/after screenshots cover the detail header, selector, Manage Accounts, and error states
  before a visual PR is created.

### Validation

Automated:

- Cursor adapter tests for same/different/malformed subjects, Auto preference, pinning, identity
  change, CAS refresh, restart, and account-scoped snapshots.
- Frontend tests for selector/manage flows, uncached switch, stale/error states, nonsecret events,
  and account-switch probe races.
- Existing cache, probe batch, CLI, Local HTTP, tray, notification, and Cursor plugin suites.
- `bun run bundle:plugins`
- `bun run test --run`
- `bun run build`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

Manual:

- Test Cursor Desktop and CLI signed into the same account, then different accounts.
- Pin one account, change one source's login during a refresh, and verify no cross-account write or
  publication.
- Restart and verify labels, selection, account IDs, availability, and cached ownership.
- Compare app detail, overview, tray, notification source, `openusage cursor --force`, and Local
  HTTP output for the same selected account.

### Risks And Dependencies

- Cursor local credential schemas and refresh behavior are external runtime inputs; real Desktop
  and CLI versions must be exercised.
- Current Cursor refresh writes are unconditional. A partial refactor that discovers accounts but
  leaves this write path unchanged is unsafe and does not satisfy the issue.
- Cache integration must incorporate the final semantics of PR #182/#204 if they land first.

Required sequence:

- Requires spec 02. Spec 01 should already be landed.
- Blocks specs 04 and 06. Spec 05 also requires the account UI/coordinator, but not Cursor itself.

Rollback (only for hard-to-reverse changes):

- Account and snapshot stores are additive. Downgrade ignores them and returns to current
  choose-one Cursor behavior using `usage-api-cache.json` v1.
- Do not delete account data during rollback.

### Open Questions

- None.

### GitHub Issue Body

## Outcome

Discover Cursor Desktop and CLI as independent local connections, reconcile their accounts, and
let users choose one active account consistently across every existing provider surface.

## Scope

- Implement Cursor's account-aware adapter and current-preference Auto rule.
- Preserve full case-sensitive JWT subjects and never merge by email.
- Add Pinned selection, account rename/manage UI, account-owned snapshots, and visible failure
  states.
- Route all probe/cache/CLI/Local HTTP/tray/notification publication through the active account.
- Add a guarded SQLite transaction to Desktop credential refresh writes and keep scoped CLI
  Keychain refreshes memory-only.
- Do not add browser collection or cross-account totals in this issue.

## Acceptance Criteria

- [ ] Same/different Desktop and CLI identities reconcile correctly and survive restart.
- [ ] Account switch, login switch, and concurrent refresh cannot cross-publish or overwrite.
- [ ] Every provider-level consumer shows the same active account.
- [ ] UI states, screenshots, redaction tests, behavior docs, and focused UAT are complete.

Use `design/backlog/03-cursor-local-multi-account.md` as the full implementation and validation
contract.
