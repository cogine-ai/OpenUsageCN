# Product Quality Delivery

Base: `5fb7e01e34492a9361ed4100e1ad01daf0fd0347` (`v0.6.39`).
Branch: `cliq/product-quality-20260907`.

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
| Q1 | Correct Z.ai/BigModel credit windows, independent quota buckets, and invalid-number handling. Correct OpenRouter reset-aware key usage. Replace OpenCode Go local quota estimates with the account API, including OpenCode 2 credential discovery. | `docs/providers/zai.md`, `docs/providers/bigmodel-cn.md`, `docs/providers/openrouter.md`, `docs/providers/opencode-go.md`, `docs/local-http-api.md`, `README.md` | In progress |
| Q2 | Make connection failures actionable. Classify known failures, retain the last successful reading, provide safe recovery actions, and recover promptly after an explicit credential/configuration change. | `docs/capture-logs.md`, `docs/app-state-architecture.md`, relevant provider docs | Queued |
| Q3 | Add an independent CLI quota check using existing numeric limits: threshold met, below threshold, or unknown; preserve existing commands and exit codes. Test stale, missing, invalid and failed readings. | `docs/cli.md`, `docs/local-http-api.md`, `README.md` | Implemented; integrated review pending |
| Q4 | Separate current quota publication from optional local-history work. Measure and remove history-induced waiting; retain error visibility, account ownership and stale-history boundaries. Evaluate native incremental reading only after that separation is verified. | `docs/providers/codex.md`, `docs/providers/claude.md`, `docs/app-state-architecture.md`, `docs/cli.md` | Queued |
| Q5 | Retain account-scoped Cursor history summaries across billing cycles; support a meaningful previous-period comparison and export with source/coverage labels. Never merge estimates with charged amounts or present incomplete data as complete. | `docs/providers/cursor.md`, new `docs/usage-history.md`, `docs/app-state-architecture.md` | Queued |
| Q6 | Improve Windows within verifiable scope: inspect credential discovery and release checks, address deterministic gaps, and record native-only acceptance requirements. Signing and live Windows acceptance require their real environment. | `README.md`, `docs/release.md`, `docs/providers/codex.md` | Queued |
| Q7 | Review existing fix PRs and repeated maintenance proposals. Reuse validated fixes, avoid duplicate implementation, and record which proposals are superseded by the final work. | This delivery record; changed behavior docs as applicable | Queued |

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
