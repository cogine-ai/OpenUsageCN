# Browser Session Broker

Status: Companion specification for
[Provider Accounts, Browser Sessions, and Cursor Model Usage](./provider-accounts-browser-sessions-cursor-history.md).

sweet-cookie is the cookie-extraction Adapter only. It solves Chromium SQLite snapshots and
macOS Keychain decryption; it does not define accounts, validate provider identity, persist a
roster, choose the active account, or own usage caches. ProviderAccounts and the provider
Adapters retain those responsibilities.

## User Flow

Browser discovery is always explicit:

1. The user opens Add Browser Account on a provider detail page.
2. The user chooses Chrome or Arc.
3. OpenUsage lists profile metadata after that action.
4. The user chooses one profile, or explicitly chooses All Profiles.
5. OpenUsage turns that choice into one independent read per exact profile and validates candidate
   sessions with the provider.
6. The user chooses one candidate to attach.

Unselected candidates stay in memory for ten minutes and are then discarded. All Profiles is a
one-time discovery instruction, not a stored locator: the broker enumerates canonical profile keys
and invokes one exact-profile read for each. The normal refresh path reads only profiles already
bound by the user and never repeats an all-profile scan.

OpenUsage does not copy Reporter's CURSOR_EXPECTED_ACCOUNTS setting. An explicit discovery receipt
reports every requested profile as verified, empty, or failed. After attachment, each exact profile
is a known connection; failure keeps that connection and account stale rather than silently
reducing the roster or suppressing successful data from another account.

For Cursor, each candidate is validated with https://cursor.com/api/auth/me. The verified
subject determines whether it creates an account or adds a connection to an existing account.
The candidate UI may show a masked, runtime-only hint.

Opening Add Browser Account authorizes only metadata enumeration. Cookie reading starts after
the user selects a profile scope. Canceling either step leaves no persisted roster.

## Helper Interface

Pin @steipete/sweet-cookie to exactly 0.4.1 in the build dependency graph and retain its MIT
license notice. Use the library API through a custom helper, not its CLI, because the library
returns structured browser/profile/store/domain metadata and supports explicit Chrome and Arc
selection without parsing terminal output.

The verified npm registry package has:

- Integrity: sha512-6cuWTGeblwzMw4/3uMzBEmgH1B+crCkJJlmTVu4vzbhG2NhAH8sMWv57fQ8JZY0nqW2ldM0/c2JM0UeQQFyJ3g==
- SHA-1: a62c5ef27dc16abc1d41c262d43b363a9de09248
- License: MIT
- Engine declaration: Node 22 or newer

The helper accepts one versioned JSON request on stdin:

    {
      version: 1
      operation: ListProfiles | ReadCookies
      browser: Chrome | Arc
      profileKey?: string
      provider?: Cursor | Claude
    }

It emits one versioned JSON response on stdout. Error responses contain a stable code and a
friendly nonsecret message. Cookie values appear only in a successful ReadCookies response and
must never be copied into an error.

ListProfiles performs metadata-only enumeration of the selected browser's profile directories
and Local State labels; it accepts no provider and reads no Cookie database. ReadCookies requires
one canonical profileKey and one provider, then delegates SQLite snapshotting and cookie
decryption to sweet-cookie. The helper rejects missing or all-profile keys. OpenUsage does not
implement Chromium cookie encryption.

The helper returns a canonical directory key such as Default or Profile 2 separately from its
mutable display label. Only the canonical key can become a bound locator; the display label is
runtime UI metadata.

The helper:

- Supports only Chrome and Arc in this release.
- Uses sweet-cookie for Chromium SQLite snapshots and macOS Keychain decryption.
- Returns browser, profile, and store ID source metadata with each cookie.
- Normalizes the Cookie host and groups by browser, profile, store ID, and host before constructing
  a candidate Cookie header.
- Uses sweet-cookie header serialization without deduplicating same-name cookies. It never merges
  same-name cookies across different hosts, stores, or profiles.
- Never logs cookie values and never includes them on stderr.
- Refuses unknown operations, providers, browsers, domains, and cookie names.

sweet-cookie's macOS defaults are not used because Arc must be requested explicitly and discovery
must stay inside the user-selected browser and profile scope.

## Rust Broker

BrowserSessionBroker is the only caller of the helper. It invokes a fixed sidecar executable with:

- A five-second timeout for metadata-only ListProfiles.
- A 15-second timeout for each exact-profile ReadCookies.
- A 60-second overall deadline for an explicit All Profiles operation.
- A two-megabyte stdout limit.
- At most six concurrent profile reads and provider validations during an explicit all-profile
  scan.
- No shell string interpolation.
- A fixed operation, provider, domain, cookie-name, browser, and profile allowlist.
- Cancellation when its owning ProviderOperation ends.

Allowlisted credentials:

| Provider | Request Origin | Accepted Cookie Hosts | Cookie Names |
| --- | --- | --- | --- |
| Cursor | https://cursor.com | cursor.com, www.cursor.com, cursor.sh, authenticator.cursor.sh | WorkosCursorSessionToken, __Secure-next-auth.session-token, next-auth.session-token, wos-session, __Secure-wos-session, authjs.session-token, __Secure-authjs.session-token |
| Claude | https://claude.ai | claude.ai | sessionKey |

For Cursor, candidate priority is cursor.com, www.cursor.com, cursor.sh, then
authenticator.cursor.sh. The broker validates one candidate with /api/auth/me and binds the
verified subject plus selected candidate to the SessionRef. It tries the next isolated candidate
only after a typed 401/403 response or a successful response without a stable sub. Timeout,
connection, redirect, invalid JSON, and HTTP 5xx errors fail that profile without switching.

Provider requests use a 30-second deadline, reject redirects, and allow only fixed HTTPS paths.
Cursor event requests include Origin: https://cursor.com. The candidate that passed /api/auth/me
is the only candidate used for subsequent requests in that operation.

The broker parses the response, zeroes or drops raw buffers as soon as practical, and stores
active values only in memory. It returns a random SessionRef bound to:

- One provider.
- One operation or attached connection.
- Exact allowed origins.
- Exact profile locator.
- Selected Cookie host and verified account ownership.
- Creation and expiry times.

Provider code makes requests through the broker. The broker injects the Cookie header after URL
validation, so React and normal QuickJS HTTP calls never receive the raw value.

A bound locator contains only browser and profile key. sweet-cookie storeId can contain an
absolute profile path, so it is used only for in-memory grouping and is never persisted or sent
to React. providers.json stores no browser data. provider-accounts.json stores no cookie,
absolute browser database path, or Keychain material.

If a profile now belongs to another identity, the broker returns IdentityChanged. The accounts
coordinator applies Auto/Pinned rules; the broker never silently rebinds the connection.

The first Chrome or Arc Safe Storage access must originate from the foreground Add Browser Account
operation. A successful attachment records only the exact profile locator. Background refresh may
reuse that locator later; it must never be the first Keychain accessor or broaden the profile scope.

Claude sessionKey rotation from Set-Cookie may update the in-memory SessionRef for the current
operation. It is not written back to the browser database or OpenUsage storage.

## Tauri Packaging

Build the helper with Bun's compiled-executable mode for:

- aarch64-apple-darwin
- x86_64-apple-darwin

The generated name follows Tauri's target-suffixed sidecar convention. Add
src-tauri/tauri.macos.conf.json with externalBin so non-macOS bundles are not affected. The
release build uses TAURI_ENV_TARGET_TRIPLE to compile or select only the matching helper.

Add tauri-plugin-shell for backend sidecar execution, but expose no shell capability to the main
window. Only BrowserSessionBroker can invoke this fixed binary. The build fails if the matching
binary, executable bit, exact dependency version, or recorded npm integrity is missing.

Pin the Bun compiler version in package metadata and CI instead of using latest. The verified
prototype used Bun 1.3.6; changing that compiler is a reviewed dependency update because it
changes the embedded runtime and binary hashes.

The packaged helper embeds its runtime, so OpenUsage users do not need Node.js 22 installed. Node
22 is a dependency constraint of the source package and build, unlike Cogine Reporter's standalone
installation requirement.

Add the sweet-cookie MIT text to THIRD_PARTY_NOTICES.md and include it in the shipped bundle.
Codesigning and notarization must cover the helper.

## Size and Evidence

The published 0.4.1 registry tarball exports ALL_PROFILES, supports the Arc selector, and retains
browser/profile/store source metadata. It compiled and ran an inline cookie fixture on both
macOS targets:

| Target | Raw binary | gzip |
| --- | ---: | ---: |
| Apple Silicon | about 56 MB | about 21 MB |
| Intel | about 61 MB | about 24 MB |

This is a material distribution-size increase. The release PR records final application,
artifact, and download sizes before approval.

This proves the exact registry package can compile with Bun 1.3.6 and run an inline fixture. It
does not prove:

- Real Chrome or Arc database discovery.
- macOS Keychain decryption.
- A denied and later accepted Keychain prompt.
- Application signing or notarization.
- Execution from a signed installed application.
- Updater artifact behavior.

Those are packaged release gates in the verification plan.

## Failure Behavior

| Failure | User result |
| --- | --- |
| Browser is not installed | Browser not found; choose another browser |
| Profile has no target cookie | No signed-in account found in this profile |
| Keychain access denied | Browser access was denied; retry from Add Browser Account |
| Exact-profile helper timeout or output cap | That profile fails; no candidate from it is retained |
| Some profiles fail in All Profiles | Show verified candidates and a visible partial-scan warning |
| Candidate receives 401/403 | Try the next isolated host candidate; fail if none validates |
| Candidate receives timeout, redirect, malformed response, or HTTP 5xx | Fail that profile without switching candidates |
| Candidate expires | Ask the user to scan again |
| Identity changes after binding | Mark connection changed; never switch a pinned account |

All technical details are logged with a correlation ID and without paths or credential values.
