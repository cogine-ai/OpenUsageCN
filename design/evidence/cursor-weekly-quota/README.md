# Cursor Shared Weekly Quota — Rendered Evidence

Captured on 2026-11-03 with synthetic fixtures after the design in
[Cursor Shared Weekly Quota](../../cursor-weekly-quota-followup.md).

These screenshots render the existing **OverviewPage**, **ProviderDetailPage** and their production
CSS directly. Production UI components were not modified. They are browser-rendered component
checks, **not installed-app or real-account acceptance**. The account name and every usage value
are synthetic; no Cursor, browser-profile or Keychain credentials were read.

**Comparison semantics:** Before and After are two manually constructed metric-line sets: a
legacy monthly projection example and a confirmed shared-weekly projection example. They are not
the same provider response replayed through old and new backend code, and do not represent a real
account or plan migration. These images prove renderer compatibility with both output shapes;
the shared Sand-fixture JS/Rust tests separately verify backend projection behavior.

| Screenshot | Meaning |
| --- | --- |
| [Before Overview](before-overview-used.png) | Old monthly Cursor Models / Other Models and independent Grok Bot. |
| [After Overview](after-overview-used.png) | Shared Weekly Usage replaces the old pools and duplicate Grok Bot. |
| [After Detail — Used](after-detail-used.png) | Weekly quota and independent On-demand spend remain separate. |
| [After Detail — Left](after-detail-left.png) | 21% used becomes 79% left; $12 used becomes $38 left of the $50 allowance. |
| [After — Narrow](after-used-narrow.png) | Both real components in the temporary harness at a 400px viewport. |

## Checks

- No Browser plugin/skill was available; used the existing Python Playwright 1.57.0 and bundled
  headless Chromium 143.0.7499.4. No dependencies were installed.
- Temporary Vite harness at `http://127.0.0.1:1431`; desktop viewport 1040 × 900 and narrow viewport
  400 × 900, device scale 1, light theme, `zh-CN`, `Asia/Taipei`.
- Synthetic clock starts at `2026-11-03T06:00:00Z`; monthly reset is December 1 and weekly reset
  November 7. This verifies rendering, not provider billing dates.
- Clicked harness controls to switch the before/after input and Used/Left props. DOM assertions
  checked real component output, preserved On-demand, and removal of Monthly Total / old pools /
  duplicate Grok Bot in the shared-weekly fixture. Existing scope rules keep On-demand in detail.
- Tauri IPC was intercepted in the browser: only the synthetic account-view read and event-listen
  call occurred. Account controls remained collapsed. No external network requests, console
  warnings/errors, framework overlay or horizontal document overflow at 400px were observed.
- The temporary harness files were moved to Trash after capture and the 1431 server was stopped.
  Full screenshots, harness copies and the detailed assertion receipt remain under
  `/tmp/openusage-cursor-weekly-render-20261103`.

Not covered: native WKWebView/Windows WebView2, installed-app navigation or settings persistence,
real credentials/API responses, dark theme, account editing and history loading. Used/Left was
exercised through harness state rather than the app's persistent settings flow.
