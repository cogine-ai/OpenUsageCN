2026-02-02

# Bundled plugins in CI

## Goal
- Ensure publish workflow bundles plugins into `src-tauri/resources/bundled_plugins/` before `tauri build`.
- Fail fast if no bundled plugins are present.

## Non-goals
- Change plugin runtime or plugin discovery logic.

## Plan
1. Run `bun run bundle:plugins` in `publish.yml` before `tauri-action`.
2. Verify at least one `plugin.json` exists under `src-tauri/resources/bundled_plugins/*/`.
