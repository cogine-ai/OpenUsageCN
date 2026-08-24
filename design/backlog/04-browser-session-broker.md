# Browser Session Broker For Chrome And Arc

## Backlog Ready Spec

### Verdict

READY WITH RISKS

The helper protocol, security boundary, profile semantics, and packaging contract are decided.
Release is still conditional on real Keychain, signing, notarization, updater, and size evidence.

### Source

Brief / issue / roadmap item:

- Use `@steipete/sweet-cookie` to add explicit macOS Chrome and Arc account discovery without
  implementing Chromium SQLite snapshots or Keychain decryption inside OpenUsage.

Related issues:

- None; the repository has zero issues and no matching issue search result as of 2026-08-24.

Related code:

- `package.json`, `bun.lock`, and `.github/workflows/{ci.yml,publish.yml}`
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- New `src-tauri/tauri.macos.conf.json`
- New `tools/cookie-helper/`, `scripts/build-cookie-helper.mjs`, and
  `src-tauri/src/browser_sessions/`
- ProviderAccounts and Manage Accounts UI from specs 02 and 03
- `plugins/cursor/plugin.js` and `plugins/claude/plugin.js`
- [Browser Session Broker Design](../browser-session-broker.md)

Current evidence:

- npm publishes `@steipete/sweet-cookie@0.4.1`.
- OpenUsage has no browser-cookie dependency, helper, `externalBin`, or shell plugin today.
- CI and publish workflows currently request Bun `latest`; the helper compiler must be pinned.

### User Outcome

From Add Browser Account, a user can explicitly choose Chrome or Arc, choose one exact profile or
All Profiles for a one-time scan, inspect verified candidates, and attach a session without
copying a cookie or configuring a token.

### Problem

Browser-only accounts are invisible to OpenUsage. Directly adding Chromium database/decryption
logic would duplicate platform-sensitive code, while invoking a generic cookie CLI would lose the
profile/store/host isolation required to prove which account owns a session.

### Scope

In:

- Pin `@steipete/sweet-cookie` to exactly `0.4.1` and retain its MIT license/integrity evidence.
- Build a custom structured helper with the reviewed Bun compiler, pinned to version `1.3.6`
  unless a separate dependency review intentionally updates that baseline.
- Support only Chrome and Arc on macOS.
- Implement `ListProfiles` metadata enumeration and exact-profile `ReadCookies` through a
  versioned JSON stdin/stdout protocol.
- Add a Rust `BrowserSessionBroker` as the helper's only caller and the only holder of raw cookies.
- Implement explicit specific-profile and All Profiles discovery, per-profile result receipts,
  memory-only candidate IDs, provider identity validation, and exact-profile attachment.
- Bind accepted sessions to opaque memory-only `SessionRef` values and persist only browser plus
  canonical profile key on the connection.
- Integrate Add Browser Account and browser detach/status into Manage Accounts.
- Package target-suffixed Apple Silicon and Intel helpers with Tauri, codesigning, notarization,
  updater artifacts, license notice, and measured size evidence.

Out:

- Startup or automatic all-profile scans.
- Chrome/Arc support on Windows/Linux, or any browser besides Chrome and Arc.
- Persisting cookies, session keys, raw browser paths, sweet-cookie `storeId`, or candidate rosters.
- Copying Cogine Reporter's configured expected-account count or merged output behavior.
- Exposing shell execution to the main window.

### Proposed Implementation Direction

Likely files/modules:

- Add the exact npm dependency and lockfile entry in `package.json`/`bun.lock`.
- Add helper source under `tools/cookie-helper/` and a deterministic target build script.
- Add `src-tauri/src/browser_sessions/` with protocol, runner, candidate roster, provider request,
  and session-reference responsibilities split into sub-500-line files.
- Add `tauri-plugin-shell` for backend fixed-binary execution, an Apple-only `externalBin` config,
  and no shell permission to `src-tauri/capabilities/default.json`.
- Update Manage Accounts UI/tests and provider account operations.
- Create `THIRD_PARTY_NOTICES.md` and ensure the notice ships in app/updater bundles.

Implementation notes:

- `ListProfiles` accepts browser only, reads metadata only, and completes within five seconds.
- `ReadCookies` requires one canonical profile key and provider and completes within 15 seconds.
- All Profiles first lists canonical keys, then runs exact-profile reads with at most six in flight
  and a 60-second total deadline. It is never persisted as a locator.
- Limit helper stdout to two megabytes; reject malformed versions, operations, browsers, providers,
  profile keys, domains, and cookie names.
- Keep unselected candidates in memory for ten minutes, then expire them.
- Cursor hosts are tried in this order: `cursor.com`, `www.cursor.com`, `cursor.sh`,
  `authenticator.cursor.sh`.
- Cursor cookie names are exactly `WorkosCursorSessionToken`,
  `__Secure-next-auth.session-token`, `next-auth.session-token`, `wos-session`,
  `__Secure-wos-session`, `authjs.session-token`, and `__Secure-authjs.session-token`.
- Claude accepts only `sessionKey` from `claude.ai`.
- Isolate candidates by browser, canonical profile, store ID, normalized host, and serialized header.
  Never merge same-name cookies across a host/store/profile boundary and do not deduplicate
  same-name cookies within sweet-cookie serialization.
- Validate Cursor with `GET https://cursor.com/api/auth/me`. Only typed 401/403 or a 200 response
  lacking stable `sub` may try the next isolated candidate. Timeout, network, redirect, invalid
  JSON, and HTTP 5xx fail that profile.
- Provider calls use fixed HTTPS origin/path allowlists, reject redirects, use a 30-second request
  deadline, and reuse the exact candidate accepted by identity validation.
- First Safe Storage access must come from the foreground Add Browser Account operation. Later
  background refresh reads only already-bound exact profiles.
- Raw values stay in helper/Rust memory and are dropped as soon as practical. React and normal
  QuickJS HTTP never receive a cookie.

Reuse existing code:

- Reuse ProviderAccounts operation receipts/selection rules, Tauri correlation/error patterns,
  provider fixed-origin transport conventions, and current release signing/updater workflow.
- Let sweet-cookie own Chromium snapshots and Safe Storage decryption; do not reproduce them.

Preserve / do not touch:

- A matching browser identity adds a connection without changing selection. A newly discovered
  account pins because attachment was explicit. Detach preserves stale account snapshot/history.
- Browser enumeration never occurs at app startup or solely because a scheduled refresh ran.
- Non-macOS builds and existing supported plugins continue to compile/package unchanged.

### Acceptance Criteria

- [ ] The lockfile resolves exactly `@steipete/sweet-cookie@0.4.1` with the recorded registry
  integrity and the MIT notice ships in `THIRD_PARTY_NOTICES.md`.
- [ ] Bun compiler version is pinned in package metadata and both CI/publish workflows; no workflow
  uses `latest` for the helper compiler.
- [ ] Without an explicit Add Browser Account action, no profile list, Cookie database, or Safe
  Storage access occurs.
- [ ] Metadata enumeration reads no cookies; canceling before a profile selection persists nothing.
- [ ] Specific-profile and All Profiles flows use exact canonical keys for Chrome and Arc; All
  Profiles is bounded orchestration and never a stored locator.
- [ ] Each requested profile is reported as verified, empty, or failed; partial success remains
  visibly Partial and never drops a previously attached account.
- [ ] Cookie candidates remain isolated by browser/profile/store/host and same-name cookies are not
  collapsed across isolation boundaries.
- [ ] Cursor fallback occurs only for 401/403 or missing-sub; other transport/protocol failures stop
  that profile.
- [ ] `/api/auth/me` ownership binds the same candidate used for every later request in the
  operation.
- [ ] Frontend receives only nonsecret candidate summaries and random IDs; storage/log/event/error
  canaries prove no cookie, session key, raw path, store ID, or subject escapes.
- [ ] New browser attachment pins a new account; matching attachment preserves selection; detach
  retains stale account data.
- [ ] Helper runner enforces 5/15/60-second deadlines, two-megabyte stdout, six-way all-profile
  concurrency, cancellation, and fixed binary invocation without shell interpolation.
- [ ] Apple Silicon and Intel helper binaries have the expected architecture/executable bit and are
  present in the correct signed/notarized app and updater artifacts.
- [ ] End users do not need Node.js 22 installed.
- [ ] Final app/archive/download size growth is measured and recorded before approval.
- [ ] `docs/providers/cursor.md`, `docs/providers/claude.md`, `docs/release.md`, README support text,
  and third-party notices match the shipped behavior.
- [ ] Before/after screenshots cover browser choice, profile choice, candidates, partial scan,
  denied access, and attached-connection states before PR creation.

### Validation

Automated:

- Helper protocol fixtures for metadata-only listing, exact reads, allowlists, malformed input,
  timeouts, output caps, candidate isolation, expiry, and cancellation.
- Rust broker tests with a fake process runner and scripted provider transport.
- Account/UI tests for explicit-action gating, specific/All Profiles, partial receipts, attach,
  detach, and no-secret serialization.
- Compile fixture and architecture checks for `aarch64-apple-darwin` and
  `x86_64-apple-darwin`.
- `bun run bundle:plugins`
- `bun run test --run`
- `bun run build`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `node --test scripts/verify-updater-signature.test.mjs`
- `git diff --check`

Manual:

- Signed installed app: Chrome Default, a non-default Chrome profile, and Arc.
- Specific profile and explicit All Profiles; no scan at launch or scheduled refresh.
- Deny the first Keychain prompt, retry from Add Browser Account, then confirm scheduled refresh of
  only the bound exact profile.
- Verify matching/new Cursor accounts, stale behavior after detach, and candidate expiry.
- Verify both target artifacts, codesigning, notarization, updater installation, license notice,
  and measured size.

### Risks And Dependencies

- Source fixtures cannot prove real Chrome/Arc layout or macOS Keychain behavior.
- The compiled helper prototype adds about 56/61 MB raw and 21/24 MB compressed for Apple
  Silicon/Intel; final distribution growth requires explicit release evidence.
- sweet-cookie and compiled Bun runtime become a sensitive local dependency boundary and must stay
  exact-version reviewed.

Required sequence:

- Requires specs 02 and 03. Blocks spec 05 and release of spec 06.

Rollback (only for hard-to-reverse changes):

- Revert the release and sidecar bundle without deleting browser connection records. Older builds
  ignore additive account data and use the v1 provider cache.
- Do not attempt to remove or edit browser Cookie databases or Keychain Safe Storage entries.

### Open Questions

- None blocking implementation. Final size acceptance is a release approval gate with measured
  evidence, not an implementation choice.

### GitHub Issue Body

## Outcome

Add explicit macOS Chrome and Arc account attachment using a signed
`@steipete/sweet-cookie@0.4.1` helper while keeping all browser credentials backend-only.

## Scope

- Add metadata-only profile listing and exact-profile cookie reads.
- Implement specific-profile and bounded All Profiles discovery with per-profile receipts.
- Validate provider identity, retain memory-only candidates/SessionRefs, and persist only exact
  browser/profile locators.
- Integrate Add Browser Account, attach, detach, partial, stale, and denied-access UI states.
- Build, sign, notarize, package, license, and size-audit both macOS helper targets.
- Do not scan at startup, persist cookies, expose shell permissions, or add non-macOS support.

## Acceptance Criteria

- [ ] Profile/cookie isolation, failure fallback, deadlines, allowlists, and no-secret tests pass.
- [ ] Real Chrome, Arc, Keychain denial/retry, bound refresh, signing, notarization, and updater UAT
  passes in the installed app.
- [ ] Final artifact-size evidence, docs, notices, redaction audit, and visual screenshots are
  complete.

Use `design/backlog/04-browser-session-broker.md` as the full implementation and validation
contract.
