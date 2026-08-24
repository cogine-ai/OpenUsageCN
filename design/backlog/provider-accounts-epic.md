# Provider Accounts Delivery Epic

## Backlog Ready Spec

### Verdict

READY WITH RISKS

Implementation can start without another product decision. Release remains gated by signed macOS
browser/Keychain UAT, private provider endpoint behavior, and the sidecar size/signing evidence.

### Source

Brief / issue / roadmap item:

- The six agreed OpenUsage updates: ccusage 20.0.20, plan labels, Claude Team seat labels,
  ProviderAccounts with Cursor multi-account, Chrome/Arc browser sessions, and Cursor model usage.
- Detailed design: [Provider Accounts, Browser Sessions, and Cursor Model Usage](../provider-accounts-browser-sessions-cursor-history.md).
- Delivery and verification: [Implementation Plan](../provider-accounts-implementation-plan.md) and
  [Verification Plan](../provider-accounts-verification-plan.md).

Related issues:

- None. `cogine-ai/OpenUsageCN` has Issues enabled and zero open or closed issues as of 2026-08-24.
- Keyword searches for account, Cursor, sweet-cookie, ccusage, plan aliases, Claude Team, and model
  history returned no issue to update.

Adjacent pull requests, not duplicates:

- [PR #182](https://github.com/cogine-ai/OpenUsageCN/pull/182) changes cross-process cache ordering in
  `lib.rs`, `local_http_api/cache.rs`, and `usage_reader.rs`; sync its final semantics before the
  active-account projection is integrated.
- [PR #204](https://github.com/cogine-ai/OpenUsageCN/pull/204) adds stale probe cache regression
  coverage in the same cache area; preserve that coverage.
- Claude credentials-file refresh uses conditional replacement; the account-aware path must retain
  it and must not refresh Keychain credentials without a value-conditional update.
- [PR #176](https://github.com/cogine-ai/OpenUsageCN/pull/176) extends HTTP redaction; use the final
  redaction baseline when auditing new provider fields.

Related code:

- `src-tauri/src/plugin_engine/{host_api.rs,manifest.rs,runtime.rs}`
- `src-tauri/src/{lib.rs,usage_reader.rs,cli.rs,probe_batches.rs,safe_file.rs}`
- `src-tauri/src/local_http_api/cache.rs`
- `plugins/{cursor,claude,codex}/`
- `src/{pages,components,hooks,stores,lib}/`
- `package.json`, `bun.lock`, `src-tauri/tauri.conf.json`, and `.github/workflows/`

Verified baseline: `origin/main` is
`04906744301b4490f4114adcb64e46c684369c4a`; npm publishes `ccusage@20.0.20` and
`@steipete/sweet-cookie@0.4.1`.

### User Outcome

Users can see correct provider plan names, keep separate Cursor accounts without configuration,
explicitly attach Chrome or Arc sessions, select the active account consistently across every
existing surface, see verified Claude Team seat names, and inspect account-scoped Cursor model
tokens and costs.

### Problem

OpenUsage currently owns state and refresh generations only by provider ID. Cursor chooses one of
its Desktop or CLI credentials, browser sessions are unavailable, Claude cannot prove an exact
Team seat, and Cursor quota endpoints do not expose model-level token history. Several small plan
and runner mappings are also behind current upstream values.

### Scope

In:

- Complete child specs 01 through 06 in the required order below.
- Preserve provider-first navigation and publish only the active account to overview, tray,
  notifications, CLI, and Local HTTP API v1.
- Keep every snapshot and history document owned by `ProviderId` plus `AccountId`.
- Add only macOS Chrome and Arc browser collection in this release.
- Update the behavior documentation listed by each child spec.

Out:

- Cross-account totals or an All Accounts view.
- Automatic all-profile browser scanning or startup cookie reads.
- Windows/Linux browser-cookie collection and Cursor-on-Windows support.
- Public account/history endpoints in Local HTTP API v1.
- Raw event storage, raw identity storage, a generic model catalog, 90/365-day history, and Cursor
  Grok Bot allowance.

### Proposed Implementation Direction

Likely files/modules:

- Use the exact files and new modules named in the six child specs.
- Keep `ProviderAccounts` as the provider-first deep Rust module with only `view(providerId)` and
  `perform(providerId, operation)` exposed to common callers.
- Keep browser extraction in `BrowserSessionBroker` and history outside the 30-second QuickJS
  probe runtime.

Implementation notes:

- Deliver the child specs in this order:
  1. [01 Low-Cost Provider Updates](./01-low-cost-provider-updates.md)
  2. [02 ProviderAccounts Core](./02-provider-accounts-core.md)
  3. [03 Cursor Local Multi-Account](./03-cursor-local-multi-account.md)
  4. [04 Browser Session Broker](./04-browser-session-broker.md)
  5. [05 Claude Team Seat Enrichment](./05-claude-team-seat-enrichment.md)
  6. [06 Cursor Model Usage History](./06-cursor-model-usage-history.md)
- Spec 06 may be developed after spec 03 in parallel with specs 04 and 05, but release it after
  spec 04 so browser-only Cursor accounts have the same history capability.
- Rebase or port the final behavior of adjacent PRs before editing overlapping files.

Reuse existing code:

- Reuse `safe_file.rs`, the cross-process cache lock/merge pattern, probe supersession rules,
  native Keychain access, existing plugin output types, and current provider-first consumers.

Preserve / do not touch:

- Keep legacy plugins on `probe(ctx)` and `usage-api-cache.json` schema version 1.
- Do not add feature flags, destructive migrations, backwards-compatibility shims, or provider
  abstractions unrelated to these six items.
- Keep internal design in `design/`; user documentation in `docs/` stays concise and behavioral.

### Acceptance Criteria

- [ ] Every child spec is completed with its automated, packaged, and applicable Live UAT gates.
- [ ] The six original requirements map to at least one child acceptance criterion with no
  unmapped requirement.
- [ ] UI, timer, manual refresh, CLI, Local HTTP stale refresh, tray, and notifications all publish
  the same active-account projection.
- [ ] Account switches and credential changes cannot publish or persist another account's quota,
  plan, history, or refreshed credential.
- [ ] No cookie, token, session key, raw subject, raw email, browser path, `owningUser`, or
  `owningTeam` appears in storage, logs, errors, crash reports, frontend events, or plugin output.
- [ ] Plugin request/response redaction is audited and tested for every changed plugin.
- [ ] Every new or materially edited source file remains below roughly 500 lines.
- [ ] README/provider documentation, release documentation, third-party notices, and before/after
  screenshots for visual PRs are present before PR creation.
- [ ] Evidence reports Static, Compiled, Packaged, Live UAT, and Released separately.

### Validation

Automated:

- `bun run bundle:plugins`
- `bun run test --run`
- `bun run build`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `node --test scripts/verify-updater-signature.test.mjs`
- `git diff --check`

Manual:

- Run the signed packaged UAT matrix in
  [Provider Accounts Verification Plan](../provider-accounts-verification-plan.md).
- Compare Cursor model data with one bounded dashboard period and verify exact account isolation.
- Verify the packaged helper on Apple Silicon and Intel, including Keychain denial/retry,
  codesigning, notarization, updater inclusion, and measured artifact-size growth.

### Risks And Dependencies

- Cursor dashboard and Claude browser-account APIs are private provider surfaces and require Live
  UAT against the current service before release.
- The compiled cookie helper adds roughly 21-24 MB compressed per target in the prototype and is a
  material release-size decision.
- Real Chromium Safe Storage prompts, signing, notarization, and updater behavior cannot be proven
  by source tests.
- Open PRs #182, #204, #184, and #176 may change overlapping baselines before implementation.

Required sequence:

- 01 before release of any other slice.
- 02 before 03, 04, 05, or 06.
- 03 before 04 or 06.
- 04 before 05 and before release of 06.
- 05 and 06 have no dependency on each other.

Rollback (only for hard-to-reverse changes):

- New account, snapshot, and history stores are additive schema-version-1 files. A previous app
  version ignores them and continues using `usage-api-cache.json` v1.
- Do not delete or rewrite new stores during rollback. Revert the release; browser connections and
  account data remain available to a later compatible version.

### Open Questions

- None blocking implementation. The risks above are release evidence gates, not product choices.

### GitHub Issue Body

## Outcome

Deliver the six approved OpenUsage updates as six ordered implementation issues while preserving
the existing provider-first product surface and strict account ownership.

## Child Issues

- [ ] Low-Cost Provider Updates
- [ ] ProviderAccounts Core
- [ ] Cursor Local Multi-Account And Active Projection
- [ ] Browser Session Broker For Chrome And Arc
- [ ] Claude Team Seat Enrichment
- [ ] Cursor Model Usage History

## Required Order

`Low-Cost -> ProviderAccounts Core -> Cursor Local -> Browser Broker -> Claude Seat`

Cursor history may start after Cursor Local, but it ships after Browser Broker. Claude seat and
Cursor history can proceed independently once their dependencies are present.

## Global Completion Contract

- All provider-level consumers show only the same active account.
- No cross-account cache, history, or credential publication is possible.
- No raw credential or provider identity crosses storage, logs, errors, events, or plugin output.
- Legacy plugins and Local HTTP API v1 remain provider-shaped and compatible.
- Signed packaged browser/Keychain/provider UAT passes for both macOS architectures.
- Behavior docs, README, license notices, redaction tests, and visual screenshots are complete.

Use the repository's `design/backlog/01-*.md` through `06-*.md` specs as the implementation and
validation contracts.
