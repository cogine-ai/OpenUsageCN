# Intuitive Usage UI

2026-11-07 · Follows the four audit findings accepted by the user.

## Design Before Implementation

Keep the existing dark/light tokens, system font, compact provider panel, borders and Lucide icons. Use grouping, selection controls and contextual status instead of repeated explanatory paragraphs. Necessary labels, failures, amount provenance and incomplete states remain accessible.

The visual specification is [intuitive-usage-ui.html](./intuitive-usage-ui.html). The user authorized the four audit recommendations; this artifact makes that direction concrete before implementation.

1. **Cursor:** three separate groups: 调用, 扣减记录, 标价估算. Requests and tokens belong together; metered and known on-demand amounts retain separate rows without a total or stacked composition. Source uses short 会话记录 / 非账单 labels. Attach incompleteness to the affected metric. Usage Events and technical cache/range definitions remain under 数据来源. Zero stays zero; unavailable stays unavailable. Keep actual dates, export, per-model breakdown, stale/error states.
2. **Account Selection:** one radiogroup containing 跟随本机 and fixed accounts. Auto mode checks only the auto row; pinned mode checks only its explicit account. Current projected identity is separate from selected mode. Auto's subtitle shows the resolved identity only while actually following. Preserve keyboard navigation and account-management controls. Backend and credential behavior do not change.
3. **History:** one 用量历史 region for Codex with 官方统计 / 本机估算 tabs, a compact 最近 31 天 label for local history, and one visible load/refresh action for the selected source. Keep independent hooks, scope ownership, cancellation and error states. Switching tabs unmounts the previous source, cancels or rejects pending results, and requires an explicit load in the newly selected source. Provider/account/credential changes still invalidate. Windows shows only supported official statistics. Amounts never cross sources or get summed. Report access/coverage/missing-date information remains contextual, with missing-day slots when a report chart has reliable coverage; no invented zeroes.
4. **Ollama:** remove both constant rules paragraphs from home and account overview. Management contains a 菜单栏 / API 默认账号 selector alongside the actual current selection (including 原有连接 and 未设置), rather than explanation elsewhere. Existing set-primary entry points retain their behavior. Shared-quota caveat appears on demand when adding a key. No automatic identity grouping, total, credential migration or primary change.

## Implementation And Verification

- Tests: selection mode versus projected identity, keyboard and failure behavior; Cursor independent amount meanings and missing/zero/partial values; history tab/source boundaries, unmount/config cancellation and platform visibility; Ollama primary control dispatch and independent home accounts.
- Docs to update: `docs/usage-history.md`, `docs/providers/cursor.md`, `docs/providers/claude.md`, `docs/providers/codex.md`, `docs/providers/ollama.md`, `docs/cli.md`, `docs/capture-logs.md`, plus `README.md` for the revised history entry. Keep design in `design/`, not in user docs.
- Evidence: matched before/after source-component preview screenshots in `design/evidence/intuitive-usage-ui/`. All amounts and identities are synthetic; native capture unavailable. Do not claim installed-app or real-account acceptance.
- Delivery: one focused branch and PR. No release, merge, installation, provider refresh or Keychain operation is part of this change.

## Review Follow-up

Keep the same layout. If disabling an account option loses keyboard focus during a pending
switch, return focus after the option is re-enabled on success or failure; respect focus the
user has moved to another control. Keep the previous fixed selection when a switch fails.
All original-connection default actions replace the previous notice only after success.
Regressions cover delayed operations, simulated browser blur, and adding a key before switching
to the original default. Provider docs describe these behaviors; no new rules paragraph is added.
