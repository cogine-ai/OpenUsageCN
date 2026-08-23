# Claude Team Seat Enrichment

## Backlog Ready Spec

### Verdict

READY WITH RISKS

The identity proof and fallback contract are explicit. The private Claude browser account response
must still be verified with real matching and mismatching accounts before release.

### Source

Brief / issue / roadmap item:

- Display `Claude Team Standard` or `Claude Team Premium` only when the existing Claude OAuth
  account and an explicitly bound Claude browser membership are proven to be the same identity.

Related issues:

- None; the repository has zero issues and no matching issue search result as of 2026-08-24.

Adjacent pull requests:

- PR #184 protects Claude credential writes during concurrent login changes and must be retained.
- PR #176 changes the generic HTTP redaction baseline, although identity calls in this issue must
  use the stricter metadata-only transport instead.

Related code:

- `plugins/claude/plugin.js`, `plugins/claude/plugin.json`, and `plugins/claude/plugin.test.js`
- ProviderAccounts Claude adapter and metadata-only transport from spec 02
- BrowserSessionBroker and Manage Accounts UI from spec 04
- `src-tauri/src/plugin_engine/host_api.rs` redaction tests
- `docs/providers/claude.md`

### User Outcome

A Claude Team user sees the exact Standard or Premium seat only when OpenUsage can prove the
browser membership belongs to the same OAuth email and organization. Every incomplete or
mismatched case remains the safe generic `Team` label.

### Problem

Claude CLI OAuth credentials expose a generic subscription type but no `seat_tier`. A browser
membership can contain that value, but applying it without matching both organization and verified
email could show another signed-in browser account's seat on the active OAuth account.

### Scope

In:

- Use the pure mappings from spec 01.
- Use the spec 02 metadata-only transport to read verified `emailAddress` and
  `organizationUuid` from `https://api.anthropic.com/api/oauth/profile` with the active OAuth
  credential.
- For an explicitly bound exact Claude browser profile, read only `sessionKey` through the broker
  and request `GET https://claude.ai/api/account` through its allowlisted path.
- Match the exact organization UUID and normalized verified email before reading that membership's
  `seat_tier`.
- Normalize matching emails by trimming surrounding ASCII whitespace and ASCII-lowercasing only;
  do not perform dot, plus-tag, Unicode, or provider-alias normalization.
- Apply `Claude Team Standard` or `Claude Team Premium` only for the two approved codes.
- Keep generic `Team` for missing, unknown, malformed, mismatched, expired, or unavailable proof.
- Surface a friendly enrichment warning/status without failing a successful Claude quota probe.

Out:

- Creating a standalone Claude account from a browser session.
- Matching accounts by email alone or persisting raw email/organization/membership data.
- Inferring a seat from plan price, organization name, role, or unknown tier values.
- Writing rotated `sessionKey` values back to the browser or OpenUsage storage.

### Proposed Implementation Direction

Likely files/modules:

- Extend the account-aware Claude adapter behind ProviderAccounts rather than exposing browser
  credentials to `plugins/claude/plugin.js`.
- Keep pure tier parsing/label resolution testable beside the Claude plugin or adapter.
- Add scripted metadata-only OAuth profile and broker account-response adapters for unit tests.
- Extend Claude account UI state only with nonsecret enrichment availability/warning data.

Implementation notes:

- The active OAuth connection remains the quota/account owner. A bound browser connection supplies
  only membership enrichment capability.
- Require both exact organization UUID equality and normalized verified email equality. Neither
  field is a fallback for the other.
- Do not use the generic plugin HTTP path for either identity response because it logs a redacted
  response prefix. Dedicated transports log only endpoint class, status, duration, and correlation
  ID.
- A `Set-Cookie` rotation may update only the current in-memory SessionRef.
- Browser mismatch is visible and nonfatal: preserve the successful quota snapshot and generic
  Team label.
- If PR #184 lands, keep its credential-generation/CAS behavior when moving Claude routing behind
  ProviderAccounts.

Reuse existing code:

- Reuse the current Claude OAuth credential loading, token refresh, quota parsing, generic plan
  fallback, spec 01 resolver, spec 02 credential leases, and spec 04 broker SessionRef.

Preserve / do not touch:

- A Claude browser session enriches only an existing OAuth account and never changes active
  selection or creates a browser-only account.
- Quota success does not depend on seat enrichment success.
- Raw OAuth/browser identity never reaches plugin output, React, Tauri events, caches, or logs.

### Acceptance Criteria

- [ ] `team_standard` renders `Claude Team Standard` only after exact organization and normalized
  verified-email match.
- [ ] `team_tier_1` renders `Claude Team Premium` only after the same proof.
- [ ] Email matching applies trim plus ASCII lowercase only and rejects alias-like differences.
- [ ] Wrong organization, wrong email, missing fields, unknown tier, malformed response, expired
  session, and transport failure all preserve generic `Team`.
- [ ] A matching browser connection enriches only the owning OAuth account and never creates or
  merges an account by email.
- [ ] Enrichment failure does not clear quota lines, change selection, or overwrite the last
  successful account snapshot.
- [ ] OAuth profile and browser account bodies never use the generic response-prefix logger.
- [ ] Storage/log/event/error canaries prove no bearer token, session key, email, organization UUID,
  membership ID, or response body escapes.
- [ ] Existing Claude refresh behavior, including final PR #184 compare-and-swap protection,
  remains covered.
- [ ] New request/response fields are audited against `host_api.rs` redaction with explicit tests.
- [ ] `docs/providers/claude.md`, README support text, and applicable plugin API docs describe exact
  labels and the generic fallback.
- [ ] Before/after screenshots show generic Team, Standard, Premium, and mismatch/warning states
  before PR creation.

### Validation

Automated:

- Resolver tests for approved, mixed-case, blank, and unknown seat values.
- Scripted identity tests for exact match, email case/whitespace, wrong email, wrong organization,
  missing fields, multiple memberships, malformed bodies, rotation, and transport errors.
- Credential generation/account switch tests that reject stale enrichment publication.
- Redaction/no-secret serialization tests.
- Existing Claude plugin and credential refresh suites.
- `bun run bundle:plugins`
- `bun run test --run plugins/claude/plugin.test.js`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

Manual:

- Signed installed app with one OAuth account and a matching browser account: verify the exact seat.
- Bind a different Claude browser account and verify generic Team plus a nonsecret mismatch message.
- Expire or remove the browser session and verify quota remains usable with generic Team.
- Switch active accounts during enrichment and verify no stale label publication.

### Risks And Dependencies

- `https://claude.ai/api/account` is a private web surface whose membership schema can change.
- Identity proof depends on both provider responses being verified and present; the design
  intentionally prefers a generic label over a guessed exact seat.

Required sequence:

- Requires specs 01, 02, and 04. It does not depend on spec 06.

Rollback (only for hard-to-reverse changes):

- No data migration is required. Revert enrichment and keep existing OAuth quota plus generic Team.
- Leave browser connection records intact; do not delete account data during rollback.

### Open Questions

- None.

### GitHub Issue Body

## Outcome

Show the exact Claude Team seat only when a bound browser membership is proven to match the active
OAuth account by both organization UUID and verified email.

## Scope

- Read OAuth profile identity through the metadata-only transport.
- Read one exact bound Claude browser account through the broker.
- Require exact organization plus trim/ASCII-lowercased email match.
- Apply only `Claude Team Standard` or `Claude Team Premium`; preserve generic Team otherwise.
- Never create a browser-only Claude account or persist/log raw identity.

## Acceptance Criteria

- [ ] Exact match, mismatch, unknown, missing, rotation, race, and redaction tests pass.
- [ ] Enrichment failure never suppresses successful quota data or changes selection.
- [ ] Signed matching/mismatching-account UAT, docs, redaction audit, and visual screenshots are
  complete.

Use `design/backlog/05-claude-team-seat-enrichment.md` as the full implementation and validation
contract.
