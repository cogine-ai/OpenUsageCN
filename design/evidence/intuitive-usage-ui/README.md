# Intuitive Usage UI Evidence

All images use synthetic accounts and amounts. They are current-source component previews, not installed-app captures. Before components were read from immutable main `00ad7e1492c1f50fef8723046ffc8d6642d95390`; after components match the initial implementation at `646d7067e7733bf7324b3ec007947a9ee551b9b1`. The same fixtures, 420px shell, theme and browser viewport were used. Images include different crops/full-page bounds; the comparison page clips them to their common component area without modifying their pixels.

The Cursor primary comparison uses both explanations collapsed. Separate expanded images preserve the detail-on-demand state. Actual account operations are covered by mocked-IPC integration tests, not by these static fixtures. No provider or Keychain calls occur in previews.

| Surface | Before | After |
| --- | --- | --- |
| Cursor | [Default](before/cursor-default.jpg), [Expanded](before/cursor.jpg) | [Default](after/cursor-default.jpg), [Expanded](after/cursor-expanded-full.jpg) |
| Accounts | [Before](before/accounts.jpg) | [After](after/accounts.jpg) |
| History | [Before](before/history.jpg) | [Official](after/history.jpg), [Local](after/history-local.jpg), [Missing Day And Zero](after/history-missing-date.jpg) |
| Ollama Home | [Before](before/ollama.jpg) | [After](after/ollama.jpg) |
| Ollama Management | Existing individual Set As Primary actions | [Explicit Default Selector](after/ollama-management.jpg) |

See [Visual Comparison](../../intuitive-usage-ui-evidence.html) and [Design](../../intuitive-usage-ui.md).

Validation after review fixes: 178 frontend test files, 2,651 tests passed; TypeScript and production build passed. The unchanged layout uses the captures above. Follow-up regressions cover delayed success/failure with simulated browser focus loss, respecting focus moved elsewhere, and replacing an old key-addition notice after a successful default change. This does not claim a native WebKit reproduction. Human review covered money classification, unavailable/zero states, account selection, and default-operation failure recovery. Rust, plugins, credential storage, network transports, and dependency manifests are unchanged. No installed-client or real-account acceptance is claimed.
