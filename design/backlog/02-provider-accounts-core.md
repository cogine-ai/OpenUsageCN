# ProviderAccounts Core

## Backlog Ready Spec

### Verdict

READY WITH RISKS

The module contract and persistence behavior are decided. Keychain-loss and cross-process writer
paths require focused failure testing before downstream provider adapters rely on them.

### Source

Brief / issue / roadmap item:

- Introduce account-scoped identity, selection, connection routing, snapshots, and publication
  ownership without converting the existing product to an account-first UI.
- Prepare verified Claude OAuth identity through a transport that never logs response bodies.

Related issues:

- None; the repository has zero issues and no matching issue search result as of 2026-08-24.

Adjacent pull requests:

- PR #182 and PR #204 touch provider cache ordering and tests used by the active projection.
- PR #184 touches Claude credential persistence that the account-aware path must preserve.

Related code:

- `src-tauri/src/plugin_engine/{host_api.rs,manifest.rs,runtime.rs}`
- `src-tauri/src/{lib.rs,usage_reader.rs,cli.rs,probe_batches.rs,safe_file.rs}`
- `src-tauri/src/local_http_api/{cache.rs,cache_tests.rs}`
- `src/lib/plugin-types.ts`
- `plugins/claude/plugin.js`
- [Provider Accounts Core Design](../provider-accounts-core.md)

### User Outcome

OpenUsage can retain stable accounts, selection, and cached ownership across restarts and across
app/CLI refreshes. Existing provider-level views keep working while account-aware providers gain a
safe foundation for multiple credential sources.

### Problem

Current probe batches, plugin output, cache, CLI refresh, and frontend state are owned only by
provider ID. Adding a second credential without a deeper coordinator would allow one account's
identity, refreshed token, snapshot, or history to be published as another account.

### Scope

In:

- Add a Rust `src-tauri/src/provider_accounts/` module split by model, store, coordinator, and
  provider adapter responsibilities, keeping each file below roughly 500 lines.
- Expose only `view(providerId)` and `perform(providerId, operation)` to UI, timer, CLI, and Local
  HTTP callers.
- Model `ProviderId -> AccountId -> ConnectionId`, with random UUID account/connection IDs.
- Reconcile identities using an installation-key HMAC fingerprint, namespaced by provider and
  identity version.
- Store the 256-bit installation key in the app-owned macOS Keychain entry.
- Implement Auto/Pinned selection, typed operation receipts, visible Partial/Failed results,
  generation-checked credential leases, and account-owned snapshot publication.
- Add `accountSupport` as an optional manifest capability and expose it through `PluginMeta`.
- Add Tauri account commands and a nonsecret revision event; frontend invoke arguments are
  camelCase.
- Add additive schema-version-1 account and snapshot stores while preserving
  `usage-api-cache.json` v1 as the active projection.
- Add a fixed-origin metadata-only native transport seam and use it for Claude
  `https://api.anthropic.com/api/oauth/profile`; parse only verified `emailAddress` and
  `organizationUuid` in process.
- Keep legacy plugins behind a one-account internal adapter without changing `probe(ctx)`.

Out:

- Cursor-specific discovery and selection UI, delivered by spec 03.
- Cookie extraction, profile binding, or browser UI, delivered by spec 04.
- Exact Claude seat application, delivered by spec 05.
- Cursor history fetch/storage, delivered by spec 06.
- Cross-account aggregation or a Local HTTP account API.

### Proposed Implementation Direction

Likely files/modules:

- New `src-tauri/src/provider_accounts/` module, registered from `src-tauri/src/lib.rs`.
- `src-tauri/Cargo.toml` for the reviewed HMAC dependency.
- `plugin_engine/manifest.rs` and its tests for optional `accountSupport`.
- `plugin_engine/runtime.rs` for an optional account-aware runtime seam.
- `host_api.rs` only where native Keychain functionality must be extracted or reused; do not grow
  another account coordinator inside that already-large file.
- `local_http_api/cache.rs`, `usage_reader.rs`, and `cli.rs` for the shared active projection path.
- `src/lib/plugin-types.ts` for nonsecret account capability/view/receipt types.

Implementation notes:

- Fingerprint exactly
  `HMAC-SHA256(installationKey, version + providerId + identityNamespace + normalizedIdentity)`.
- Raw provider identity is process-only. Persist only the fingerprint, random IDs, user label,
  selection, and nonsecret connection locator.
- If an account registry exists but the Keychain key cannot be read, do not generate another key
  or reconcile duplicate accounts. Keep the last provider projection readable and surface a
  persistence error.
- `SelectActive` always pins. `FollowDefaultConnection` returns to Auto.
- Selecting an uncached account publishes loading, never the prior account snapshot with a new
  label. Failed pinned refresh does not fall back.
- A lease binds account, connection, provider origins, capability, credential generation, expiry,
  and cancellation. Recheck it before publishing output, writing a token, or committing history.
- Account labels trim, accept 1-64 visible characters, and reject controls/line breaks.
- Store corruption is retained for diagnosis, logged with a correlation ID, and shown as a
  friendly warning. Never start empty silently over an existing unreadable registry.
- The Claude OAuth profile response cannot use the generic QuickJS HTTP response-prefix logger and
  is neither displayed nor persisted raw. This issue records identity preparation only.

Reuse existing code:

- Reuse `safe_file.rs`, the Local HTTP cache's cross-process lock/safe merge approach, current
  native Keychain access, `LatestProbeBatches` supersession behavior, `PluginOutput`, and existing
  provider-first consumers.

Preserve / do not touch:

- Keep `usage-api-cache.json` at schema version 1 and keep its external provider-shaped payload.
- Do not infer an account from the old cache. Seed an account snapshot only after a verified probe.
- Do not persist credentials, raw identity, raw email, organization name/UUID, browser path, or
  runtime credential-generation values.
- Do not add a feature flag, destructive migration, generic All Accounts output, or account
  behavior to manifests that omit `accountSupport`.

### Acceptance Criteria

- [ ] Random `AccountId` and `ConnectionId` values persist across restart after the same verified
  identity is observed.
- [ ] Identity fingerprints include version, provider, and namespace and cannot collide across
  providers or identity namespaces for the same raw value.
- [ ] A pre-existing registry plus a missing/unreadable Keychain key fails visibly, preserves the
  old active projection, and creates neither a replacement key nor duplicate accounts.
- [ ] Auto, Pinned, SelectActive, FollowDefaultConnection, stale, unavailable, and uncached-loading
  states behave exactly as specified.
- [ ] `Succeeded`, `Partial`, and `Failed` receipts enumerate requested-source outcomes; Partial
  cannot turn identity or history failure into success.
- [ ] Account labels enforce the 1-64 visible-character boundary after trim.
- [ ] Account and snapshot writers merge safely across app and CLI processes by ProviderId and
  AccountId and never overwrite a newer generation.
- [ ] Credential leases reject output, credential writes, and future history commits after account
  or credential-generation changes.
- [ ] `provider-accounts.json` and `provider-account-snapshots.json` are schema version 1 and contain
  no forbidden raw data.
- [ ] `usage-api-cache.json` stays version 1 and projects only the selected account.
- [ ] Optional `accountSupport` parses and serializes without changing legacy manifest behavior.
- [ ] Tauri commands use `providerId` and other camelCase frontend arguments; revision events carry
  only provider ID and monotonic revision.
- [ ] Claude OAuth identity parses only verified email and organization UUID through the dedicated
  metadata-only transport, stores neither raw value, and does not claim an exact seat.
- [ ] Legacy plugin, CLI, scheduled refresh, manual refresh, and Local HTTP regression tests pass.
- [ ] `docs/plugins/api.md`, `docs/plugins/schema.md`, `docs/app-state-architecture.md`, and
  `docs/local-http-api.md` describe user-visible behavior without copying internal design.

### Validation

Automated:

- Rust unit tests with temporary stores and in-memory Keychain/transport adapters for identity,
  selection, leases, safe merging, corruption, migration, and Claude profile parsing.
- Existing `local_http_api::cache`, `probe_batches`, `usage_reader`, CLI, manifest, and runtime
  regression suites.
- `bun run bundle:plugins`
- `bun run test --run`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

Manual:

- Start with only a v1 usage cache and verify it remains visible before the first identified probe.
- Restart after creating, renaming, pinning, and returning an account to Auto.
- Deny access to the installation-key Keychain item and verify no replacement registry/key appears.
- Run app and one-shot CLI refreshes against the same provider and inspect account ownership.

### Risks And Dependencies

- The Keychain key is the sole stable input for identity fingerprints; loss behavior must remain
  fail-closed or accounts will duplicate.
- App/CLI cross-process ordering may change when PR #182 lands. Integrate its final `startedAt`
  semantics instead of maintaining a parallel last-write rule.
- Claude credential persistence must retain PR #184's final compare-and-swap behavior if it lands.

Required sequence:

- Spec 01 should land first. This spec must land before specs 03-06.

Rollback (only for hard-to-reverse changes):

- Stores are additive. A previous version ignores them and continues to use
  `usage-api-cache.json` v1.
- Rollback never deletes the registry, installation key, or snapshots. Reverting the release leaves
  them available to a later compatible build.

### Open Questions

- None.

### GitHub Issue Body

## Outcome

Add the Rust ProviderAccounts foundation so every credential, snapshot, selection, and future
history write has explicit account ownership while existing provider-level consumers remain
compatible.

## Scope

- Add provider/account/connection identity, Auto/Pinned selection, typed operations, credential
  leases, account snapshots, safe cross-process stores, and the active v1 projection.
- Persist only HMAC identity fingerprints and nonsecret locators using an app-owned Keychain key.
- Add optional manifest account capability, Tauri view/perform commands, and nonsecret revision
  events.
- Keep legacy plugins and Local HTTP API v1 provider-shaped.
- Collect Claude OAuth profile identity through a fixed-origin metadata-only transport without
  applying an exact Team seat.

## Acceptance Criteria

- [ ] Identity, selection, lease, corruption, Keychain-loss, writer-race, and migration tests pass.
- [ ] Account switches cannot relabel or publish a previous account's snapshot.
- [ ] No raw identity or credential enters stores, logs, events, errors, or plugin output.
- [ ] App, CLI, timer, manual refresh, and Local HTTP use one active-account projection path.
- [ ] Legacy manifests/probes and `usage-api-cache.json` v1 remain compatible.
- [ ] Required behavior docs and redaction tests are complete.

Use `design/backlog/02-provider-accounts-core.md` as the full implementation and validation
contract.
