# Ollama Unified Home Evidence

The [design brief](../../ollama-unified-home.md), [interactive specimen](../../ollama-unified-home.html)
and design screenshots were completed before product code changes. The user authorized this
direction together with implementation. Design states include light/dark, a configured original
connection, partial failure, empty state and narrow width.

## Production Components

| Scenario | Before | After |
| --- | --- | --- |
| Two named connections, original connection missing | [Original-only error](before-home-dark.png) | [Both account quotas](after-home-dark.png) |
| Configured original connection with a named primary | Original connection required a separate surface | [Three independent rows](after-with-legacy-light.png) |

Additional states: [management](after-management-dark.png), [original API Key reports](after-legacy-detail.png),
[partial refresh failure](after-partial-error.png), [no configured connections](after-empty.png),
[320px home](after-home-320.png).

Before uses the production OverviewPage from `7bc4b2e`, with the same synthetic old-connection error
and two named connections. After renders the current production AppContent, OverviewPage,
account list, connection management and detail/report components. Both use production CSS and
the app theme tokens; the external harness supplies the background normally provided by the app frame.

Chromium 143.0.7499.4, zh-CN locale, Asia/Taipei time zone. The browser assertions passed at
320/400/600 CSS pixels without horizontal overflow. Thirty-two checks cover both named quotas
without choosing a primary, unchanged original settings, primary selection preserving all rows,
viewed-account reports, explicit original-connection report routing while a named account is primary,
Cookie report unavailability, all-account refresh, partial failure and an actionable empty state.

All identities, values and IPC responses are synthetic. No external requests, page errors,
framework overlays or console errors occurred in the final run. The harness and receipt remain
outside the repository. No installed application, real credentials, real provider requests or
native-webview acceptance are claimed by these screenshots.

The design and implementation preserve separate connection snapshots. No per-account allowance
or purchased-credit values are added together, including multiple keys belonging to one user.
