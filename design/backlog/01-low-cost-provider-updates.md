# Low-Cost Provider Updates

## Backlog Ready Spec

### Verdict

READY

### Source

Brief / issue / roadmap item:

- Upgrade the primary ccusage runner to the currently published `20.0.20`.
- Add Cursor `pro_plus -> Pro+` and Codex `prolite` / `pro_lite` / `pro-lite -> Pro 5x`.
- Add the pure Claude Team seat resolver used later by browser-proven enrichment.

Related issues:

- None; the repository has zero issues and no matching issue search result as of 2026-08-24.

Related code:

- `src-tauri/src/plugin_engine/host_api.rs`
- `scripts/bump-ccusage-version.mjs`
- `plugins/cursor/plugin.js` and `plugins/cursor/plugin.test.js`
- `plugins/codex/plugin.js` and `plugins/codex/plugin.test.js`
- `plugins/claude/plugin.js` and `plugins/claude/plugin.test.js`
- `docs/plugins/api.md` and the three provider docs

Current evidence:

- `CCUSAGE_VERSION` and its Rust tests/docs still name `20.0.2`; npm reports `20.0.20`.
- Codex already maps only `prolite`; the underscore and hyphen aliases are absent.
- Cursor passes `pro_plus` through the generic formatter, which cannot produce `Pro+`.
- Claude formats `subscriptionType` generically and has no exact Team seat resolver.

### User Outcome

Users receive the current ccusage behavior and see stable product names instead of raw provider
identifiers, without changing authentication, quota semantics, or account behavior.

### Problem

The pinned runner is behind the approved npm release. Provider identifiers containing underscores,
hyphens, or vendor seat codes render incorrectly or cannot be expressed by the generic titlecase
formatter.

### Scope

In:

- Change the primary ccusage package version from `20.0.2` to exactly `20.0.20`.
- Keep the existing release-age-safe `18.0.11` fallback and package-manager fallback chain.
- Add provider-local, case-insensitive, trim-aware plan resolvers for the approved aliases.
- Map Claude `team_standard` to `Claude Team Standard` and `team_tier_1` to
  `Claude Team Premium` when an exact seat code is supplied.
- Preserve generic `Team` when no verified seat code exists.
- Update tests and concise behavior docs.

Out:

- ProviderAccounts, browser identity collection, or applying a Claude seat without identity proof.
- Any new plan alias not observed in the approved sources.
- Changes to ccusage output normalization, time windows, fallback version, or package-manager order.

### Proposed Implementation Direction

Likely files/modules:

- Update the version through `scripts/bump-ccusage-version.mjs`, then inspect the generated
  `host_api.rs` and documentation changes.
- Add small pure resolver functions beside existing provider plan formatting in each plugin.
- Extend the existing plugin and Rust unit tests instead of adding a shared abstraction.

Implementation notes:

- Normalize only for comparison using trim plus lowercase; do not mutate unknown display values
  beyond the existing formatter behavior.
- Codex's accepted set is exactly `prolite`, `pro_lite`, and `pro-lite`.
- The Claude resolver is preparation only. Existing OAuth `team` remains generic until spec 05
  supplies an identity-matched seat code.

Reuse existing code:

- Reuse `ctx.fmt.planLabel`, `formatCodexPlan`, current ccusage runner/fallback logic, and existing
  provider test helpers.

Preserve / do not touch:

- Do not change plugin schemas, quota endpoints, credential paths, or ccusage legacy fallback.
- Do not introduce a global plan-name registry for three provider-local mappings.

### Acceptance Criteria

- [ ] The primary runner invokes exactly `ccusage@20.0.20` for Claude and Codex paths.
- [ ] Release-age handling still falls back to `ccusage@18.0.11` or
  `@ccusage/codex@18.0.11` exactly as it does today.
- [ ] Cursor `pro_plus`, including mixed-case and surrounding whitespace, displays `Pro+`.
- [ ] Codex `prolite`, `pro_lite`, and `pro-lite`, including mixed-case and surrounding
  whitespace, display `Pro 5x`.
- [ ] Claude `team_standard` resolves to `Claude Team Standard` and `team_tier_1` resolves to
  `Claude Team Premium`.
- [ ] Missing, blank, and unknown inputs retain the existing null/generic formatting behavior.
- [ ] A generic Claude Team account is not upgraded to an exact seat by this issue.
- [ ] `docs/plugins/api.md`, `docs/providers/cursor.md`, `docs/providers/codex.md`,
  `docs/providers/claude.md`, and applicable README support text match the shipped behavior.
- [ ] New request/response fields are not introduced; the plugin redaction audit records that
  result before PR creation.

### Validation

Automated:

- `bun run bundle:plugins`
- `bun run test --run plugins/cursor/plugin.test.js plugins/codex/plugin.test.js plugins/claude/plugin.test.js`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib ccusage`
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

Manual:

- Probe one provider using the packaged runner and confirm logs name `ccusage@20.0.20` without
  exposing command paths or credentials.
- Render fixture outputs for each approved alias and one unknown value.

### Risks And Dependencies

- ccusage behavior can change between pinned releases; existing normalization and fallback tests
  must pass rather than assuming version-only compatibility.

Required sequence:

- No predecessor. Land this before the account and browser slices to keep later diffs focused.

Rollback (only for hard-to-reverse changes):

- No data or schema migration. Revert the version, resolver, tests, and docs together.

### Open Questions

- None.

### GitHub Issue Body

## Outcome

Update the pinned ccusage runner and normalize the approved Cursor, Codex, and Claude plan codes.

## Scope

- Pin the primary runner to `ccusage@20.0.20`.
- Preserve the current `18.0.11` legacy fallback and runner order.
- Map Cursor `pro_plus` to `Pro+`.
- Map Codex `prolite`, `pro_lite`, and `pro-lite` to `Pro 5x`.
- Add pure Claude mappings `team_standard -> Claude Team Standard` and
  `team_tier_1 -> Claude Team Premium`; do not apply an exact seat without later identity proof.
- Update focused tests and behavior docs.

## Acceptance Criteria

- [ ] Approved mappings are trim-aware, case-insensitive, and covered by tests.
- [ ] Unknown values preserve current formatting behavior.
- [ ] ccusage runner, fallback, release-age policy, and normalization tests pass.
- [ ] No authentication, quota, or plugin schema behavior changes.
- [ ] Plugin redaction audit and required docs are complete.

## Validation

Run the focused plugin tests, Rust ccusage tests, plugin bundling, frontend build, Cargo check, and
`git diff --check` listed in `design/backlog/01-low-cost-provider-updates.md`.
