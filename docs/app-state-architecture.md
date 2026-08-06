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

## Shared usage readers

- The menu-bar app and one-shot CLI both run the same plugin probes and read the same provider settings.
- Plugin installation and successful snapshot writes use cross-process locks, so simultaneous app and CLI runs do not read partial plugin updates or overwrite newer provider data.
- Snapshot ordering uses each probe's start time, so a slower older refresh cannot replace a newer refresh that finished first. Completion time is still stored for freshness checks.
- `/v1/limits` projects that cache into stable numeric resources. The CLI can also refresh stale data without starting the Tauri UI or local HTTP server.

## Guardrails
- Keep source-of-truth state in dedicated stores (`app-ui-store`, `app-plugin-store`, `app-preferences-store`).
- Keep derived values computed in domain hooks and passed directly to composition components.
- Avoid effect-based mirroring of derived values into a separate store.
- Keep derivations pure and colocated with domain hooks.
