# Product Quality Delivery

Base: `5fb7e01e34492a9361ed4100e1ad01daf0fd0347` (`v0.6.39`).
Branch: `cliq/product-quality-20260907`.
Worktree: `/Users/kiedis/Coding/AI/openusage-quality-20260907`.

## Working Contract

Complete small, reviewable changes in order: verify the problem, record the smallest
design, implement it, run focused checks, then review the integrated result. Keep
the existing provider/account separation, public limits contract, and last good
data. A simulated provider response proves parsing behavior, not live account or
packaged-app acceptance. Do not publish a release or alter third-party credentials
as part of this work. Independent provider changes may be prepared in parallel;
each is accepted and committed separately.

## Work Queue

| Item | Outcome And Initial Scope | Behavior Docs | Status |
| --- | --- | --- | --- |
| Q1 | Correct Z.ai/BigModel credit windows and independent quota buckets. Correct OpenRouter reset-aware key usage. Replace OpenCode Go local quota estimates with the account API, including OpenCode 2 credential discovery. | `docs/providers/zai.md`, `docs/providers/bigmodel-cn.md`, `docs/providers/openrouter.md`, `docs/providers/opencode-go.md`, `docs/local-http-api.md`, `README.md` | Implemented and locally verified |
| Q2 | Make connection failures actionable. Classify known failures, retain the last successful reading, provide safe recovery actions, and recover promptly after an explicit credential/configuration change. | `docs/capture-logs.md`, `docs/app-state-architecture.md`, relevant provider docs | Implemented and locally verified |
| Q3 | Add an independent CLI quota check using existing numeric limits: threshold met, below threshold, or unknown; preserve existing commands and exit codes. Test stale, missing, invalid and failed readings. | `docs/cli.md`, `docs/local-http-api.md`, `README.md` | Implemented and locally verified |
| Q4 | Separate current quota publication from optional local history. Measure and remove history-induced waiting; retain error visibility, account ownership and stale-history boundaries. | `docs/providers/codex.md`, `docs/providers/claude.md`, `docs/app-state-architecture.md`, `docs/cli.md`, `docs/plugins/api.md`, `docs/plugins/schema.md` | Implemented; review correction verified |
| Q5 | Retain account-scoped Cursor history across billing cycles; support previous-window comparison and CSV export with source/coverage labels. Keep estimated and charged amounts separate. | `docs/providers/cursor.md`, new `docs/usage-history.md`, `docs/app-state-architecture.md` | Implemented and locally verified |
| Q6 | Fix deterministic Windows credential guidance and document native acceptance requirements. | `README.md`, `docs/release.md`, `docs/providers/codex.md` | File-credential tests passed; native Windows acceptance not run |
| Q7 | Review existing fix PRs and repeated maintenance proposals. Reuse validated fixes and record which proposals are superseded by this branch. | This record, `docs/providers/opencode.md`, `docs/providers/amp.md`, `README.md` | Four concrete PRs assessed; relevant fixes implemented |

## Acceptance

- Provider regressions must first fail against the base implementation, then pass
  against the fix. Audit changed request/response fields against Host redaction.
- New CLI behavior must be exercised through argument parsing and the real
  decision path, with stdout/stderr and exit codes verified.
- UI changes must have before/after screenshots and tests of user-visible behavior.
- Run the complete frontend tests/build, cookie-helper tests, and relevant Rust
  tests/checks after integration. Distinguish pre-existing, environment and new
  failures. Run independent standards and behavior review before completion.
- Record real Windows, account, signing and release work separately from local
  tests. Keep the source checkout untouched and retain this worktree for review.

## Evidence And Decisions

- Setup: source checkout is clean, local and remote main match the base above.
- Reused prior read-only evidence: OpenRouter uses lifetime usage for a resettable
  key; both GLM plugins reject `CREDIT_LIMIT`; OpenCode Go computes local estimated
  quota despite an available account API.
- Existing capabilities: Cursor accounts and current-cycle history, quota pace
  notifications, standalone CLI and `/v1/limits` already exist.
- Clean frontend baseline: build passed; 98 files / 1,405 tests passed.
- Rust baseline: generated the required packaged Cookie Helper, then ran 432
  library tests. 430 passed; two pre-existing ccusage child-process tests failed
  (`ccusage_runner_retries_legacy_package_when_current_package_fails` and
  `ccusage_timeout_kills_descendant_and_closes_pipes`). Investigation belongs to Q4.
- OpenRouter: 10 new regressions failed on the original code; all 16 plugin tests
  pass after using remaining quota, preserving overdrawn values and rejecting
  unknown current-window counters. Existing all-time counters include BYOK only
  when the key explicitly requires it. Request fields are unchanged; newly read
  remaining/reset/BYOK fields are nonsecret counters and policy flags. Existing
  Authorization and configured-key redaction covers the request credential.
- CLI guard: 13 focused Rust tests pass, including existing CLI commands, exact
  threshold boundaries, invalid arguments before provider access, stale and reset
  windows, missing resources, and failed reads. The native debug binary builds.
  Snapshot expiry and failed refreshes always produce an unknown decision.

### Provider Accuracy And Recovery

- Z.ai and BigModel accept both `CREDIT_LIMIT` and `TOKENS_LIMIT`. They preserve
  separate credit buckets and actual reset windows; malformed values are visible
  warnings, not zero usage. The exact five-hour and seven-day windows retain the
  public session/weekly resource mapping. Focused coverage: 117 tests, including
  78 new regressions.
- OpenCode Go now reads `/zen/go/v1/usage`. Both the legacy `auth.json` and OpenCode
  2 SQLite credential store are supported, with an exact `opencode-go` provider
  match. A generic `sk-` key search could select another provider and was excluded.
  Focused coverage: 45 plugin tests plus an actual in-memory SQLite query fixture.
- Recovery distinguishes known expired-login, file-credential, network and format
  failures. Retry remains available after an error even inside the normal manual
  refresh cooldown; the last successful quota remains visible with an explanation.
  Detailed errors are redacted before display and never create arbitrary links.
- Changed provider fields were audited against Host redaction. Bare credential
  `key`, `access` and `refresh` fields are covered, as are Z.ai subscription/customer
  identifiers and Amp subscription text. Malformed sensitive responses are
  redacted as a whole. Focused Host coverage: 96 tests.

### Independent Local History

- Codex and Claude normal probes return current quota without invoking `ccusage`.
  Detail pages explicitly load or refresh the latest 31 calendar days of local
  usage. Those API-price estimates stay outside quota caches, notifications, CLI
  and Local HTTP results.
- Claude requires the selected account's available CLI connection. The backend
  verifies credential generation, identity and current account binding before
  returning a result. A history failure does not fail or replace current quota.
- Independent review found that ordinary quota view events cleared completed or
  pending Claude history. Commit `10186f5` fixes that by using actual account/CLI
  connection identity. Five new event-chain regressions first produced three
  failures; all five pass after the fix. Same-account operations preserve history
  and temporarily disable new history loads.
- Runner discovery and execution share the bounded history timeout. The two
  baseline Rust test failures were traced to parallel tests changing `TMPDIR`
  while child processes were using it. Those environment-mutating tests now
  share a serial guard; the complete Rust suite passed afterward.
- A native incremental log-reader rewrite was not included: separating explicit
  history work removed the measured quota dependency. The remaining history
  scan is bounded and user-requested; no production profiling evidence currently
  justifies replacing its parser and pricing behavior in this delivery.

The isolated benchmark injected a fixed 500ms local-history delay with immediate
synthetic quota responses. Every entry was called three times with a fresh plugin
context. It measured public plugin calls only, excluding network, Rust/Tauri,
identity verification and UI rendering.

| Provider | Old Quota Call | New Quota Call | Explicit History Call | History Calls Per Quota Refresh, Old / New |
| --- | --- | --- | --- | --- |
| Codex | 504.110–506.557 ms | 0.166–2.543 ms | 504.518–505.612 ms | 1 / 0 |
| Claude | 504.107–507.111 ms | 0.205–1.049 ms | 503.657–506.503 ms | 1 / 0 |

These results verify removal of the injected waiting time; they are not a claim
about production speedup. Source fingerprints and raw measurements are saved in
the local QA artifact directory under `probe-benchmark/`.

### Cursor History And Export

- The local store retains up to 12 recorded windows per account, replaces an
  updated reading of the same billing cycle, and reads existing version-one data.
  Actual time coverage, billing-cycle boundaries, timezone and source remain
  explicit; complete pagination does not mean a complete billing cycle.
- Percentage comparison requires matching account, source, timezone, covered
  duration and position within the billing cycle. Incomplete prices or a zero
  previous amount do not produce a misleading percentage.
- CSV export reads the selected stored snapshot and writes a new file in Downloads
  without overwriting an existing file. It keeps aggregate metered charges separate
  from model list-price estimates, preserves unknown values, and handles CSV
  quoting and formula-like model names. Focused coverage: 60 Rust and 28 frontend
  tests before the final whole-suite run.
- Browser checks at 360px and 540px covered selecting a stored window without
  refreshing the provider, correct selected-snapshot export, friendly export
  failure and successful retry. The narrow comparison table supports keyboard
  scrolling and does not overflow the page.

### Existing PR Decisions

The PRs below were inspected at their exact heads and remained open on the final
readback. Their useful behavior is implemented locally; this work did not merge
or close the original PRs or change maintenance automations.

| Existing Proposal | Inspected Head | Decision In This Branch |
| --- | --- | --- |
| [#173 OpenRouter remaining quota](https://github.com/cogine-ai/OpenUsageCN/pull/173) | `fc4040b86dce3cc78831b7c7424e6affcd56103e` | Implemented with stricter reset, BYOK, invalid-number and overdrawn-quota coverage. |
| [#212 OpenCode 2 support](https://github.com/cogine-ai/OpenUsageCN/pull/212) | `675645b44251f38e68090f27a327a03c71482735` | Kept exact-provider credential discovery. Replaced the old local-session quota estimate with official account usage, so its session-message migration is superseded. |
| [#193 OpenCode low percentages](https://github.com/cogine-ai/OpenUsageCN/pull/193) | `3190e764c18b0070dd2515f00819e1f87bae92be` | Fixed 0.1%/0.5% being multiplied by 100; three regressions failed before the fix and all 11 plugin tests pass. The PR also had unrelated older Cursor changes and merge conflicts, so it was not taken wholesale. |
| [#203 Amp paid subscriptions](https://github.com/cogine-ai/OpenUsageCN/pull/203) | `6d414dc02e38dd10d50f493baaf0098dbcf07f1b` | Implemented Other/Orb remaining-percent parsing and plan display, with 49 tests. Removed guessed 30-day reset timestamps; approximate renewal text stays approximate. |

### References Used For Scope

- [CodexBar at the inspected revision](https://github.com/steipete/CodexBar/tree/4f760cfc9b5e1b9540ba35fbe976e15d24c3b5ae)
  supplied reference behavior for Z.ai credit windows and independent local usage.
- [OpenUsage at the inspected revision](https://github.com/robinebers/openusage/tree/70dea9a8fa21ed205aa9ad625b416a1e7792d5a1)
  informed the comparison; the existing OpenUsageCN provider/account, CLI and
  Local HTTP architecture was retained.
- [OpenCode's official usage handler](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/console/app/src/routes/zen/go/v1/usage.ts)
  and [credential schema](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/schema/src/credential.ts)
  were checked against the implementation.
- [Codex credential storage documentation](https://learn.chatgpt.com/docs/auth#credential-storage)
  supports the explicit Windows file-storage guidance. OpenUsageCN never changes
  Codex's credential mode or logs a user in automatically.

## Verification Record

- Final frontend verification at `2c67cda`: production build passed; all 110 files /
  1,632 frontend/plugin tests passed. Vite retains its existing main-chunk size
  warning (560.87kB minified); it does not fail the build.
- The preceding full run exposed a pre-existing App test timing problem: a probe
  event was injected outside React `act`, allowing a native menu to capture an
  uncommitted loading state. A deterministic immediate-menu reproduction failed
  three times; explicit state submission fixed it, and the final focused check
  passed 20 times. Commit `2c67cda` changes only the test and its missing settings
  mocks, preserving the exact enabled-menu and manual-refresh assertions.
- At `43a85e9`: production frontend build and 109 files / 1,627 frontend/plugin
  tests passed; 466 Rust library tests passed; the macOS debug binary built;
  all 18 Cookie Helper tests passed. Subsequent changes were limited to frontend
  history lifecycle, narrow-window styles, tests and documentation; Rust and
  helper source did not change after their passing runs.
- Native CLI subprocess checks covered help and invalid arguments, including
  missing provider, unsupported window and `NaN` thresholds, with exit codes
  checked. No real account was accessed by these checks.
- Two independent reviewers checked the whole branch and the subsequent history
  correction. The sole confirmed P2 was corrected and rechecked; no remaining
  confirmed findings were reported. Focused review runs included 216 tests before
  the correction and 38 tests after it; overlapping runs are not added to the
  full-suite totals.
- Browser evidence uses real components with mocked Tauri IPC and synthetic
  accounts. Before/after screenshots, event/retry/export checks and benchmark data
  are retained at
  `/Users/kiedis/.codex/visualizations/2026/09/07/01a07bdb-6bb0-7522-a664-ee7ca187b589/openusage-quality`.
- Windows file-credential coverage has seven passing plugin tests, including
  explicit `CODEX_HOME`, spaces and absent files. Actual Windows cross-compilation
  was attempted and failed because the macOS host has no Windows SDK `assert.h`
  for the `ring` C build. Native Windows install, tray, update, sign-in and sleep
  recovery were not tested. The existing Windows CI build was inspected but not
  dispatched by this work.
- Real provider accounts, native packaged-app UI, release signing, packaging,
  publishing and production deployment were not tested or performed. Existing
  release prerequisites in `docs/release.md` still apply.
- The original checkout remains clean at the base revision. The independent
  worktree is retained for review and uses approximately 6.2GB, including generated
  build dependencies and artifacts. The two temporary browser QA servers were
  stopped after verification. No source-branch reset, stash, merge or push occurred.
