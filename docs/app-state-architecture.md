# App State Architecture

## Source of truth stores
- `app-ui-store`: UI view state (`activeView`, `showAbout`)
- `app-plugin-store`: plugin metadata + persisted plugin settings
- `app-preferences-store`: persisted user preferences (display/theme/tray/system)

## Derived values
- `displayPlugins` + `navPlugins` are computed by `useAppPluginViews`.
- `settingsPlugins` is computed by `useSettingsPluginList`.
- `autoUpdateNextAt` is runtime scheduling state from `useProbe`.
- Automatic refresh skips providers that are still loading or inside the short failure backoff. Manual refresh still retries immediately.
- Reset-boundary refreshes are one-shot probes for providers whose reported quota reset arrives before the next automatic refresh.
- If refreshes overlap for the same provider, only the last one started can update the displayed result or saved limits. Older refreshes may still finish, but their results are ignored.
- If a newer refresh cannot start, the latest earlier refresh that is still running remains responsible for that provider. A start error is shown only when no running refresh can take over.
- An older batch finishing does not end the loading state of a newer refresh.
- `useProviderStatus` keeps the latest successful status-page result per supported provider; failed checks are logged without being shown as provider incidents.
- `usePaceNotifications` keeps in-memory per-metric notification state. A provider is primed on its first successful data, removed when disabled, and re-armed after recovery or a real reset window.
- `selectedPlugin` is computed by `useAppPluginViews`.

## Main data flow
1. `App.tsx` composes hooks and owns cross-domain orchestration.
2. Source stores are updated from bootstrap/settings/probe actions.
3. Derived hooks recompute view models from source state.
4. `App.tsx` passes derived values directly to `AppShell` and `AppContent`.
5. `AppShell` and `AppContent` render from those direct props and source stores.

## Connection Recovery

- Provider cards show short recovery advice for recognized credential, login, permission, network, rate-limit, and response-format errors. Unrecognized failures stay explicitly unclassified.
- Error details remain available as selectable text with common credential values hidden. URLs from error messages do not become action links.
- A failed refresh keeps the last successful data visible beside the recovery message and Retry button.
- Explicit retry from the card, sidebar, or Refresh All bypasses the previous successful refresh's cooldown for failed providers. Loading providers still cannot be retried twice at once. Successful providers keep the normal cooldown.
- These actions do not add automatic retries or change failure backoff. Saving provider settings and switching accounts keep their existing immediate refresh paths.
- Recovery advice does not edit credentials. Claude Code remains responsible for renewing its Keychain credentials.

## Shared usage readers

- The menu-bar app and one-shot CLI both run the same plugin probes and read the same provider settings.
- Plugin installation and successful snapshot writes use cross-process locks, so simultaneous app and CLI runs do not read partial plugin updates or overwrite newer provider data.
- Account-aware providers reconcile local identities into stable accounts before probing. The app and CLI both publish only the selected account into the existing provider cache.
- Account selection, labels, identity fingerprints, and account-owned snapshots use separate versioned stores. Raw identities, credentials, and browser cookies are not stored there.
- On macOS, the generated installation key is sent to Keychain without placing its value in process arguments. Existing service and account names remain unchanged across upgrades.
- Account changes are serialized per provider and persisted before the in-memory view changes. Browser attachments carry a revision so an older process cannot restore a connection that was explicitly detached.
- Account revision events contain only a provider id and monotonic revision. The frontend fresh-reads the account view instead of receiving account data in the event.
- Switching to an account without a readable snapshot removes the previous account's provider projection while the new probe is loading. A failed probe does not overwrite a previously successful snapshot for the same selected account. If the account registry itself is unavailable, the last projection stays readable with an error instead of being silently deleted.
- `/v1/limits` projects that cache into stable numeric resources. The CLI can also refresh stale data without starting the Tauri UI or local HTTP server.

## Recorded Cursor Windows

- Cursor history retains at most 12 recorded windows per account, separately from quota snapshots. A successful refresh replaces the saved snapshot for the same billing cycle without adding overlapping events twice.
- Recorded windows keep their actual coverage, time zone and billing-cycle boundaries. Complete pagination does not imply a complete billing cycle. Old records without cycle metadata remain readable and are labelled as unknown-cycle coverage.
- Selecting an older record reads local data only. CSV export reads the chosen stored record, uses a new file in Downloads, and keeps list-price estimates separate from metered amounts. Failed exports remain visible to the user and in logs.
- Comparisons require matching coverage and cost completeness; unavailable comparisons do not show a change percentage. See [Usage History](usage-history.md).

## Local Detail History

- Codex and Claude quota probes do not run `ccusage`. The app, CLI, and fresh `/v1/usage` snapshots contain their live quota data without local history lines.
- The detail page loads local history only after an explicit request. The history command and hook own their result, loading state, error, and update time; they never publish a quota event or write quota snapshots.
- An old request cannot replace a newer request or a different account's result. Claude also checks the selected local connection, credential generation, verified identity, and persisted account binding before returning history. Accounts without that local connection cannot load it.
- Local history describes the current log directory and API-price estimates, not an account bill. It is not persisted and does not enter the tray, notifications, CLI, or Local HTTP cache. Closing the detail page or changing its account scope clears it.
- History runner discovery and execution share a separate bounded runtime budget. A failed history request remains visible in the history section and leaves quota freshness unchanged.

## Account-Scoped Detail Data

- Cursor Model Usage is loaded only while a Cursor detail page has an active account.
- The backend decides the current time once for each refresh. The UI supplies only the selected IANA time zone, whose rules are applied to each event.
- Its job key includes provider, account, billing window, time zone, and credential generation. A selection or credential change rejects the old result before publication.
- Only complete aggregates are stored by account. They are detail-only and do not enter the overview, tray, notifications, CLI, or Local HTTP cache.

## Guardrails
- Keep source-of-truth state in dedicated stores (`app-ui-store`, `app-plugin-store`, `app-preferences-store`).
- Keep derived values computed in domain hooks and passed directly to composition components.
- Avoid effect-based mirroring of derived values into a separate store.
- Keep derivations pure and colocated with domain hooks.
- Never mirror an account-scoped snapshot into provider state until the coordinator has rechecked account ownership and selection.
