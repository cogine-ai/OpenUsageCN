2026-02-02

# Bundled plugins runtime sync

## Goal
- Ensure bundled plugins are always present and updated in the app data plugins dir.
- Avoid empty plugin lists when the install dir has stray files.

## Non-goals
- Delete or remove user-installed plugins.
- Add remote plugin updates.

## Plan
1. Always copy bundled plugins from app resources into `{appDataDir}/plugins` on startup.
2. Copy merges overwrite existing bundled plugin files but does not delete extra files.
