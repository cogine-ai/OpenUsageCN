# Contributing To OpenUsageCN

OpenUsageCN accepts focused contributions that improve AI provider usage tracking.

## Ground Rules

- Keep changes focused on usage tracking.
- Add tests when a bug fix or provider change can be covered.
- Include before and after screenshots for visual changes.
- Keep implementation simple and consistent with existing patterns.
- Use one PR per concern.

## Add A Provider Plugin

Each provider is a plugin. See the [Plugin API docs](docs/plugins/api.md) for the full spec.

1. Create a new folder under `plugins/` with your provider name.
2. Add `plugin.json` metadata and `plugin.js` implementation.
3. Add documentation in `docs/providers/`.
4. Test it locally with `bun tauri dev`.
5. Open a PR with screenshots showing the provider working.

## Fix A Bug

1. Describe the root cause and the fix.
2. Add a regression test when practical.
3. Include screenshots for UI bugs.
4. Run `bun run build` and `bun run test` before opening a PR.

## Code Standards

- TypeScript for frontend code in `src/`.
- Rust for backend code in `src-tauri/`.
- No new dependencies without clear justification.
- Follow the project instructions in [AGENTS.md](AGENTS.md).

## Maintainers

Maintainer and release ownership is managed in the [OpenUsageCN repository](https://github.com/cogine-ai/OpenUsageCN).
