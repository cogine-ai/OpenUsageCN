# PR 264 Merge Review

Reviewed against base `920bbccd680a081b4e6ead60d3ec9654e1e5dfe7` on 2026-11-05.
The initial reviewed head was `e8522e97202c4cda9ec16adeda83948d7541b402`; this report accompanies
the additional fixes in the same PR. Merge requires successful checks on the final head.

## Existing CI And Review

At the initial head, Linux type checking/build/tests, ARM and Intel macOS Cookie Helper checks,
and Windows tests/build/NSIS all passed. CodeRabbit's check was Neutral because its included
review allowance was exhausted; it was not a new successful full-head review.
Its three formal threads were resolved after `e8522e9`, and the render-time ref write was removed.

The older general review at `a97790a` was rechecked against current code:

- Keep the stored result's identity rejection when preparing published output. Constructing
  output directly from an unprocessed successful result could bypass `apply_probe`'s identity
  mismatch suppression. The final internal invariant check is not a current functional bug.
- Leave the small GUI/CLI preparation duplication. Publication validation and cleanup already
  share the same lock-protected implementation; further extraction is optional refactoring.
- Fix discarded friendly errors. Owned Rust command strings now reach the alert; unexpected
  error objects and empty values stay generic, and raw failures are not logged.

## Additional Manual Review

Two independent passes inspected backend identity/credential storage, GUI and CLI publication,
server reports, cache cleanup and lock order, and frontend browsing/primary selection, replacement,
removal, original configuration, report cancellation, and failure handling.

- Fixed queued primary refreshes using removed or replaced keys. After waiting for the
  connection lock, the captured generation is checked again before any runtime request.
  Two deterministic tests failed on the prior implementation and now pass. They check that
  no synthetic request marker is written and the newer stored credentials remain unchanged.
- Fixed frozen account-detail reset countdowns. The existing 30-second visibility-aware ticker
  updates the metric; a fake-time test proves labels change without a quota request.
- Confirmed corrupt-store cleanup remains inside the account lock, stale generations do not
  delete newer projections, and restoring a selected snapshot does not recursively take the lock.
- Confirmed existing settings are not migrated, new keys are masked, cross-user replacement
  requires explicit add, and removal never revokes provider keys or silently selects another account.

Home/tray and individual connections retain their existing refresh schedules and shown update
times. This review does not change the global manual-refresh cooldown or promise live cross-page
synchronization. This is separate from the verified account-isolation guarantees.

## Follow-up Review And Interaction Design

The fresh automated review on `f3f68ba` identified two backend corrections: clear the
mutex poison marker after recovering its existing pending state, and retain a valid Ollama
projection after a runtime panic while still invalidating an unreadable account store.

Keep report invalidation on quota refresh. Removing the refresh state and timestamp from
the report key conflicts with the existing report-isolation rule in `docs/usage-history.md`:
refresh clears loaded reports and cancels pending responses even when quota refresh fails.
Credential revision alone also does not detect the upstream identity-change rejection.

Interaction design for the manually found managed-account gap: when the app starts refreshing
the primary connection, its open detail view clears loaded reports, cancels pending reports,
and disables Load Reports until that refresh finishes. Failure leaves reports cleared and
allows an explicit new load. Viewing a different connection is unaffected. Keep the existing
layout, labels and disabled-button appearance; pass the app's refresh state into this existing
behavior rather than introducing another control.

Implemented and verified with production-page regressions: loaded and pending primary reports
are invalidated across failed app refreshes, while other connections' loaded and pending reports
remain available. Two new tests failed before the fix. The backend poison and valid-panic-cache
regressions also failed before their fixes. Browser before/after evidence is linked in the
[evidence index](evidence/ollama-multi-account/README.md).

## Final Validation

Regression coverage includes queued removal/replacement, friendly string versus unsafe object
failures, account/report isolation, preserved original configuration and countdown updates.
Final local test/build results are recorded in the PR description; CI must be checked on the
exact final head before merge.

After the follow-up fixes, local validation passed: 2,195 JavaScript tests in 155 files,
667 Rust tests with 3 existing ignored tests, the production frontend build, Rust binary
checks and changed Rust formatting using the repository's 2024 edition. Browser checks for
primary-refresh report clearing passed. These checks use synthetic data only.

The [failure-message comparison](evidence/ollama-multi-account/merge-review/after-verification-error.png)
uses the actual production key form and CSS with synthetic IPC. Its
[before image](evidence/ollama-multi-account/merge-review/before-verification-error.png) uses `e8522e9`.
Chromium 143.0.7499.4 at 400×700 showed the specific backend explanation, no overflow or framework
overlay, no external provider requests, and only the expected fixed error log.
No installed application, real credentials or real-service acceptance is claimed.
