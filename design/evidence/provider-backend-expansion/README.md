# Provider Usage Expansion — Rendered Evidence

Captured on 2026-11-04 after the [design](../../provider-backend-expansion-2026-11-04.md).
Before uses baseline `13cfb31` manifests and detail-page component; Cursor's before panel also uses its production component from
that commit. After uses the current production components and manifests. Existing connection-page
components render both old and new source definitions.

All accounts, metric values, report results and IPC are synthetic. The before/after metric inputs
are illustrative output shapes, not the same real service response replayed through two backend
versions. These images verify presentation and interaction; plugin regression fixtures and real
QuickJS tests separately verify protocol parsing and projection. No installed-app, native webview,
real-login or real-service acceptance is claimed.

| Feature | Before | After |
| --- | --- | --- |
| Antigravity cycles | [Before](before-antigravity.png) | [After](after-antigravity.png) |
| OpenRouter scope and reports | [Before](before-openrouter.png) | [After](after-openrouter.png) |
| Ollama balance and reports | [Before](before-ollama.png) | [After](after-ollama.png) |
| ChatGPT reports and local history | [Before](before-codex.png) | [After](after-codex.png) |
| Cursor charge classification | [Before](before-cursor.png) | [After](after-cursor.png) |
| MiniMax new quota windows | [Before](before-minimax.png) | [After](after-minimax.png) |
| Perplexity subscription pools | [Before](before-perplexity.png) | [After](after-perplexity.png) |
| Ollama connection | [Before](before-ollama-connection.png) | [After](after-ollama-connection.png) |
| MiniMax connection | [Before](before-minimax-connection.png) | [After](after-minimax-connection.png) |
| Perplexity connection | [Before](before-perplexity-connection.png) | [After](after-perplexity-connection.png) |

Report states: [Loading](after-reports-loading.png), [Error And Retry](after-reports-error.png),
[Empty](after-reports-empty.png), [400px Narrow](after-reports-narrow.png),
[Dark](after-reports-dark.png). The normal report example preserves negative credit text and
readable values beside a separate Access Denied section. The same generic report fixture is used
for the three report providers to exercise shared rendering; it does not promise that every
provider returns ChatGPT-style fields.

Checks passed: independent Load Reports action, partial permissions, negative text values,
selected source radio state and corresponding credential field, loading/disabled action,
error/retry, empty response, and no horizontal document overflow at 400px.
No external requests, page errors or unexpected console warnings/errors occurred. The deliberate transport-error scenario produces
the expected fixed client error log.

Environment: Chromium 143.0.7499.4 with existing Python Playwright, 600×960 and 400×900 viewports,
zh-CN locale, Asia/Taipei time zone. Production CSS and components are imported by a temporary
Vite harness. Raw harness, screenshots, capture script and receipts remain under
`/tmp/openusage-provider-expansion-qa-20261104`; no browser automation dependency was added.
The dark harness applies the application's background color to its host canvas as well as the components.
The harness is removed from the working tree before the PR.
