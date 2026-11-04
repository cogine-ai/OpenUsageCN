# Ollama Multi-Account UI Evidence

Captured on 2026-11-04 after the multi-account design was approved in the task conversation.

Before uses the production detail and connection pages copied from `920bbcc` before editing.
After uses the new production pages and shared UI components. Both use production CSS;
the external Vite harness explicitly scans the repository's source for Tailwind utilities.

| Surface | Before | After |
| --- | --- | --- |
| Account usage | [Single connection](before-detail.png) | [Independent account summaries](after-overview.png) |
| Key configuration | [Single Key field](before-config.png) | [Named connections](after-connections.png) |

Additional states: [Verify Before Saving](after-add-verified.png),
[Viewed Account Reports](after-detail-reports.png),
[Temporary Refresh Failure](after-refresh-error.png), [Dark Appearance](after-overview-dark.png).

The browser assertions cover viewing without primary selection, connection-bound reports,
discarding late results, temporary failures retaining quota and its update time, failed verification
not saving, confirmation before add, cross-user replacement becoming a new connection, primary
removal without fallback, and checking the original configuration independently of a managed primary.
The management, overview and add pages fit 320, 400 and 600 CSS pixels without horizontal overflow.

All account identities, values and IPC responses are synthetic. No external provider request was
made. The only console errors are the deliberately injected key-verification and original-connection
failures; no browser page errors or framework overlays occurred. These screenshots do not establish
native-webview, installed-app, real-login or real-service acceptance.

Environment: Chromium 143.0.7499.4, existing Python Playwright, zh-CN locale, Asia/Taipei time zone.
The Browser plugin was unavailable. The capture script, mock transport and baseline source copies
remain outside the repository; no browser dependency or test credential was added to the app.
