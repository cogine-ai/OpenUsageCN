# Product Quality Screenshots

These screenshots use the actual before/after React components with synthetic
provider data and mocked Tauri IPC. They contain no real account credentials,
usage, or local history. They verify rendering and interactions, not native
packaging or live-provider acceptance.

- Before source: `5fb7e01e34492a9361ed4100e1ad01daf0fd0347`.
- After source: product changes through `2c67cda9da97237c4ee90e1dda6781fe6c24d386`.
- Capture date: September 7, 2026.
- Browser: Playwright with installed Chrome; 540px capture width. The same flows
  were also exercised at 360px, including keyboard scrolling in the comparison.

| Flow | Before | After |
| --- | --- | --- |
| Recover after an expired login while preserving quota | [Before](recovery-before.png) | [After](recovery-after.png) |
| Load local history independently of live quota | [Before](local-history-before.png) | [After](local-history-after.png) |
| Select, compare and export recorded Cursor windows | [Before](cursor-history-before.png) | [After](cursor-history-after.png) |
| Show Amp paid subscription quotas | [Before](amp-before.png) | [After](amp-after.png) |

The prior/selected Cursor fixture windows deliberately have matching timezone,
duration, billing-cycle offset and complete price coverage. A separate interaction
check selected an incomparable window and confirmed that no percentage was shown.
CSV checks verified the selected stored key, an explicit export error and recovery
on retry. Local-history checks covered ordinary quota events, same-account refresh,
and replacement of the CLI connection while a history request was pending.
