# Cursor Backend Device Acceptance

Date: 2026-11-02 (Asia/Taipei). Current checkout's Rust/QuickJS backend on this Mac.
This initial backend-only stage did not replace the installed application. The subsequent local
installation and its separate UI acceptance status are recorded in
[Local Installation Acceptance](local-install-2026-11-02.md). No product UI was changed.

## Current Result

Backend acceptance passed after the user explicitly authorized the system Keychain prompt
and the identity-response compatibility was corrected.

| Check | Result |
| --- | --- |
| Explicit system authorization for Cursor Safe Storage / Cursor Key | Completed successfully; helper exit 0 |
| Cursor login database values before/after authorization | Unchanged |
| Subsequent no-prompt backend Keychain access | Passed |
| Desktop accessToken and refreshToken encrypted decoding | Passed using the actual stored ciphertext |
| Desktop account-scoped identity verification and quota refresh | Two consecutive successful refreshes, four numeric quota metrics each |
| CLI account-scoped identity verification and quota refresh | Two consecutive successful refreshes, four then three numeric quota metrics |
| Desktop stored credentials and login metadata before/after refresh | Unchanged |
| CLI credential values and Keychain metadata before/after refresh | Unchanged |
| Desktop Keychain item metadata before/after backend refresh | Unchanged |

Optional quota lines depend on their endpoint responses. This acceptance proves the primary
account-scoped refresh succeeds; it does not certify every optional endpoint or quota type.
The existing tokens were usable. Expired-token OAuth renewal was covered by regression tests,
not by forcing expiry or altering live credentials.

## Authorization

The user explicitly requested that the agent trigger the native prompt for their approval.
One `/usr/bin/security` read of the specified item triggered it. Its stdout was consumed by
an in-memory buffer and immediately zeroed; no password was printed or saved. The helper had
a 120-second limit. It neither clicked the prompt nor edited ACLs programmatically.
The user-approved authorization was completed before the refresh integrity baselines.
The intended system permission change is distinct from the subsequent checks that the backend
did not mutate item metadata during refresh.

## Identity Compatibility And Isolation

The actual `/api/auth/me` response supplied a bare string `sub`; the JWT supplied a complete
provider-prefixed subject. Previously the mismatch prevented the scoped refresh despite HTTP 200.

The corrected local-session rule requires:

- the exact access token's raw complete subject must match the selected account;
- a complete response subject must match exactly;
- a bare response may match only the exact user component of that same token's single,
  unambiguous `provider|user` subject;
- whitespace, ambiguous separators, another provider or another user are rejected;
- account IDs, fingerprints, credential generations and cache ownership remain based on the
  complete subject. Accounts sharing a user suffix are not merged.

The Rust history path applies equivalent response binding only to explicitly local candidates.
Browser/opaque candidates are not expanded. Complete-subject lease checks remain unchanged.
Regression tests cover different providers sharing a suffix, refreshed-token identity changes,
credential changes, ambiguous/duplicate cookies, and whitespace in JWT or server subjects.
History request authentication compatibility was tested with synthetic fixtures; a complete
live paginated history download was not part of this quota-refresh acceptance.

## Integrity Checks

Before and after each backend attempt the opt-in harness compares in-memory digests of:

- Desktop accessToken, refreshToken, cachedEmail, stripeMembershipType, stripeSubscriptionStatus;
- Desktop Safe Storage item metadata;
- CLI access/refresh credential values and item metadata.

Only pass/fail, response status and field names are printed. Secrets, digests and identities
are not persisted to this report. Provider data uses a temporary directory, leaving the installed
application's account registry and snapshots untouched. No login/logout, token writeback or
application restart was performed.

## Reproduction

These tests are ignored by default and require an explicit environment switch:

```bash
OPENUSAGE_LIVE_CURSOR_ACCEPTANCE=1 cargo test --manifest-path src-tauri/Cargo.toml --lib live_cursor_acceptance -- --ignored --nocapture --test-threads=1
```

The Desktop and CLI scoped tests each run two refreshes and check integrity even on failure.
The direct CLI endpoint diagnostic is separate and does not publish any account snapshot.

## Earlier Failure Evidence

Before authorization, the Desktop item existed but its ACL did not permit `/usr/bin/security`.
The backend safely returned `denied:` and credentials remained unchanged.
Before identity compatibility was fixed, CLI Keychain reads succeeded and `/api/auth/me` returned
200, but the complete-subject guard rejected the abbreviated response and no snapshot was published.
A separate direct quota diagnostic returned 200 with valid numeric quota fields. That diagnostic
alone was not treated as scoped acceptance. Both original blockers have now been resolved for
the verified Desktop/CLI quota-refresh paths.
