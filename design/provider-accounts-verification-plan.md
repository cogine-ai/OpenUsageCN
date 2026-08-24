# Provider Accounts Verification Plan

Status: Companion specification for
[Provider Accounts, Browser Sessions, and Cursor Model Usage](./provider-accounts-browser-sessions-cursor-history.md).

## Automated Tests

Low-cost updates:

- Plan mapping tables, including Cursor pro_plus, Codex prolite/pro_lite/pro-lite, Claude
  team_standard/team_tier_1, unknown values, and mixed-case inputs.
- ccusage 20.0.20 runner, fallback, release-age policy, arguments, and normalization.

Accounts:

- Same Cursor subject across Desktop and CLI merges.
- Different Cursor subjects remain separate.
- Cursor identity preserves the full case-sensitive subject and auth0 prefix; cookie-construction
  suffix parsing never changes account identity.
- A local JWT subject and /api/auth/me.sub must match exactly; mismatch fails as IdentityChanged.
- Account IDs survive restart with the Keychain index.
- Missing Keychain index fails visibly and does not create duplicate accounts.
- Auto, Pinned, identity-changed, unavailable, and stale selection.
- Selecting an uncached account shows loading instead of the prior account's output.
- Attaching a new browser identity pins it; attaching a matching connection preserves selection.
- Detaching the last browser connection retains a stale account snapshot and history.
- Account labels enforce trimmed 1-to-64 visible characters and reject controls and line breaks.
- Partial receipts enumerate failed sources and never publish success-shaped identity or history data.
- Credential refresh compare-and-swap race.
- Legacy plugins and usage-api-cache.json v1 remain unchanged.
- Concurrent account-store writers, safe merge, and corruption.

Browser broker:

- No explicit action means no profile enumeration or helper invocation.
- Specific-profile and explicit All Profiles orchestration for Chrome and Arc; All expands to exact
  per-profile helper calls and never persists an all-profile locator.
- Same cookie name in two profiles, stores, or Cursor hosts remains isolated candidates.
- Cursor candidate priority is deterministic. Only 401/403 or missing sub permits fallback;
  timeout, redirect, malformed JSON, network failure, and HTTP 5xx do not.
- Five-second metadata, 15-second exact-profile, 60-second all-profile, six-way concurrency,
  candidate expiry, partial scan, output cap, malformed protocol, and cancellation.
- Only allowlisted providers, origins, cookie names, browsers, and operations.
- First Safe Storage access must be foreground; startup and scheduled refresh cannot broaden or
  create browser bindings.

Claude:

- OAuth profile parsing variants.
- Browser email and organization must both match before seat enrichment.
- Missing identity, wrong organization, wrong email, and unknown seat tier keep generic Team.

Cursor history:

- POST /api/dashboard/get-filtered-usage-events uses the exact account-verified Cookie candidate
  and matching Cursor Origin for every page.
- Short/empty final page and exact total.
- Adjacent boundary overlap and legitimate equal events.
- Full page at cap, count drift, missing page, and unexplained duplicate failure.
- Numeric strings, malformed numbers, negative values, and integer overflow.
- Missing list costs preserve known values with Partial coverage.
- Invalid cost remains Invalid after later valid rows.
- Missing charged cost removes the whole-window metered total.
- Credential switch, account switch, cancellation, and stale publication rejection.
- Chrome and Arc accounts with the same model stay in separate AccountId documents and views.
- Failure of one account history job leaves other account history and quota snapshots untouched.

Security:

- Serialization and logs contain no defined token, cookie, session key, subject, email,
  owningUser, or owningTeam canaries.
- New plugin request/response fields have matching host_api.rs redaction tests.

Compatibility:

- Legacy plugin probes and manifest parsing remain unchanged when accountSupport is absent.
- usage-api-cache.json remains version 1 and active projection is identical for single-account
  providers.
- Fresh install, upgrade with only v1 cache, downgrade ignoring new stores, corrupt account store,
  and missing installation Keychain key.
- Scheduled refresh, manual refresh, CLI one-shot, and Local HTTP stale refresh select the same
  active account and never race publication generations.

Required local commands before a PR:

- bun run bundle:plugins
- bun run test --run
- bun run build
- cargo test --manifest-path src-tauri/Cargo.toml --lib
- cargo check --manifest-path src-tauri/Cargo.toml
- node --test scripts/verify-updater-signature.test.mjs
- git diff --check

## Build and Package Gates

- Build the helper for aarch64-apple-darwin and x86_64-apple-darwin.
- Verify binary architecture and executable permission.
- Verify @steipete/sweet-cookie is exactly 0.4.1 with the recorded npm integrity.
- Verify the reviewed Bun compiler version is pinned in package metadata and CI rather than latest.
- Verify THIRD_PARTY_NOTICES.md is shipped.
- Verify application codesigning includes the helper.
- Verify notarization and updater artifacts for each architecture.
- Measure application, archive, and download-size growth and record the accepted result.

## Signed Packaged UAT

Browser:

- Chrome Default and a non-default profile.
- Arc with at least one signed-in profile.
- Specific-profile and explicit All Profiles flows.
- A denied Keychain prompt and a later successful retry.
- Foreground attachment followed by a successful scheduled refresh of only the bound profile.
- No browser scan at launch or scheduled refresh.

Cursor accounts:

- Desktop and CLI signed into the same account.
- Desktop and CLI signed into different accounts.
- A browser profile that matches a local account.
- A browser profile that adds another account.
- A pinned account while one source changes login.
- Restart preserves selection, label, and correct cached ownership.
- Chrome and Arc accounts using the same model never display a flattened all-account total.

Claude:

- Matching OAuth and browser identity produces the exact Team seat label.
- A different browser account does not enrich the OAuth account.

Cursor history:

- Compare per-model token totals and list costs with the Cursor dashboard for one bounded period.
- Compare the separate metered total when the dashboard exposes it.
- Switch accounts during a fetch and confirm no cross-account publication.
- Disconnect during a later page and confirm the previous complete snapshot remains.

## Evidence Labels

Report these separately:

| Label | Meaning |
| --- | --- |
| Static | Source, schema, and unit-test evidence |
| Compiled | Helper or application builds for a target |
| Packaged | Signed artifact launches and contains the expected helper |
| Live UAT | Real browser, Keychain, provider account, and dashboard behavior |
| Released | Published artifacts and updater metadata are verified |

The source-level dual-target helper prototype is only Compiled evidence with an inline fixture.
Browser and history features remain unverified until Signed Packaged UAT passes.
