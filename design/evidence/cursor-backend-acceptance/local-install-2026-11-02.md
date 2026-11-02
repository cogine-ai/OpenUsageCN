# Local Installation Acceptance

Date: 2026-11-02 (Asia/Taipei).

## Installed Artifact

The first backend batch and identity compatibility fix were built as a native arm64
OpenUsageCN 0.6.44 app bundle and installed at `/Applications/OpenUsageCN.app`.
The version number was retained for this local build. This was not a public release.

- Main executable and Cookie helper signed with the existing Developer ID and Team LMWH2NK82S.
- Same bundle identifier: `ai.cogine.openusagecn`.
- Deep, strict code-signature validation passed before and after installation.
- Bundled Cursor and OpenCode Go plugin scripts matched the current source files.
- Cookie helper build verification passed: arm64, macOS 13 deployment target, protocol startup.
- Local app signing completed without a new notarization submission; no Gatekeeper bypass was used.
- Installed executable matched the built artifact byte for byte.

The old application was stopped for replacement. The previous signed application and application
settings/account data were retained in a private rollback directory:

`/Users/kiedis/Library/Application Support/OpenUsageCN Local Builds/20261102-first-backend-batch`

The installation used `cp` and `mv`, preserving the original application and existing data.

## Actual Installed Runtime

The new installed menu-bar process started its local service successfully with 29 known providers.
Its own Cursor cache was refreshed at `2026-11-02T10:27:00.867232Z` (18:27 Taipei), after startup,
with Total usage, Cursor Models, Other Models and Grok Bot metrics.

A second force-refresh through the installed application's CLI exited zero, returned fresh data
at `2026-11-02T10:29:02.272997Z` (18:29 Taipei), and exported totalUsage, autoUsage, apiUsage and
grokBotUsage resources. This exercised the installed bundle and original account registry, not a
test harness or a replacement temporary profile.

The original active account is bound to Arc. The application retained that binding and selection;
no local account was automatically re-added or substituted. Earlier backend-only acceptance
separately verified actual Desktop and CLI sessions.

## Data Integrity

All comparisons with the private pre-install baseline passed after installation and refresh:

- Cursor's stored `cursorAuth/*` login values, including encrypted access and refresh tokens;
- Cursor Safe Storage item metadata;
- Cursor CLI access/refresh item metadata;
- OpenUsageCN's existing installation-key item metadata;
- existing Cursor account IDs, active account and selection mode.

The Cursor token fields remained encrypted. No Keychain permission change, login/logout or
credential replacement was performed during installation. The previously user-approved Keychain
authorization remained usable. Only hashes were retained in the private integrity baseline;
raw credentials were not saved to this report.

## Manual UI Acceptance — Completed

After the user opened the menu-bar panel, native automation successfully read the actual
installed application's UI. The panel initially retained an older failed refresh with
`Account credentials changed during refresh. Try again.` and data from 18:31.

The Cursor refresh button was clicked once. The interface entered its updating state, then
removed the error and stale markers and restored quota forecasts. The installed GUI process
published a new Cursor snapshot at `2026-11-02T10:54:27.582451Z` (18:54:27 Taipei), containing
Total usage, Cursor Models, Other Models and Grok Bot. The displayed remaining percentages
were approximately 82%, 29% and 48% for the three visible pools.

The account page still showed the original selected Account 3 and its Arc / Default connection.
No login, account selection, re-add, detach or rename operation was performed. The application
was left on the successful overview page.

All comparisons with both the manual-refresh baseline and relevant pre-install baseline passed:
Cursor login values were unchanged, Desktop access/refresh remained encrypted, Cursor and CLI
Keychain item metadata were unchanged, the existing OpenUsageCN installation-key metadata was
unchanged, and account IDs/active selection were preserved. Digests were compared privately;
no token, cookie, password, account email or identity fingerprint is recorded here.

A screenshot of the final actual overview is retained only in the private rollback/acceptance
directory as `manual-refresh-ui.png`, not in the repository, because it includes personal usage.

The initial credential-change protection warning was no longer present after the successful
manual retry. Its earlier cause was not established: browser-session expiry or concurrent
reacquisition can trigger this guard without changing the stored login. No guard was disabled.
This records one successful manual quota refresh, not an endurance test or complete history-download
acceptance.
