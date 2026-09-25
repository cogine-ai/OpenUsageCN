# Provider Settings Before And After

These screenshots render the actual `SortablePluginItem` settings component. The before view shows the existing Claude, Codex, and Cursor starter rows. The after view adds DeepSeek, Moonshot, Ollama Cloud, Doubao, and xAI as enabled rows.

The capture uses synthetic configured status from mocked Tauri IPC. It contains no real credentials or account usage and does not prove live provider access. Plugin API behavior and automatic enablement are covered by separate tests.

- Before source: `617a9c0` (the provider row component is unchanged by this PR).
- After source: this PR's provider manifests and provider row component.
- Capture date: September 26, 2026.
- Browser: Playwright with installed Chrome, 540px viewport width.

| Before | After |
| --- | --- |
| [Starter providers](before.png) | [Five added providers](after.png) |
