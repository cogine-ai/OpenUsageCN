# OpenUsageCN

Track AI coding subscription usage from your macOS menu bar.

![OpenUsageCN Screenshot](screenshot.png)

## Download

[**Download The Latest Release**](https://github.com/cogine-ai/OpenUsageCN/releases/latest) (macOS, Apple Silicon & Intel)

## What It Does

OpenUsageCN lives in your menu bar and shows how much of your AI coding subscriptions you have used. Progress bars, badges, and clear labels keep usage visible without digging through provider dashboards.

- **One Glance.** All your AI tools, one panel.
- **Always Up-To-Date.** Refreshes automatically on a schedule you pick.
- **Global Shortcut.** Toggle the panel from anywhere with a customizable keyboard shortcut.
- **Lightweight.** Opens instantly and stays out of your way.
- **Plugin-Based.** New providers are added as plugins.
- **[Local HTTP API](docs/local-http-api.md).** Other local apps can read usage data from `127.0.0.1:6736`.
- **[Proxy Support](docs/proxy.md).** Route provider HTTP requests through a SOCKS5 or HTTP proxy.

## Supported Providers

- [**Amp**](docs/providers/amp.md) / free tier, bonus, credits
- [**Antigravity**](docs/providers/antigravity.md) / all models
- [**Claude**](docs/providers/claude.md) / session, weekly, extra usage, local token usage (ccusage)
- [**Codex**](docs/providers/codex.md) / session, weekly, reviews, credits
- [**Copilot**](docs/providers/copilot.md) / premium, chat, completions
- [**Cursor**](docs/providers/cursor.md) / credits, total usage, auto usage, API usage, on-demand, CLI auth
- [**Factory / Droid**](docs/providers/factory.md) / standard, premium tokens
- [**Grok**](docs/providers/grok.md) / credits used, plan, pay-as-you-go cap
- [**JetBrains AI Assistant**](docs/providers/jetbrains-ai-assistant.md) / quota, remaining
- [**Kiro**](docs/providers/kiro.md) / credits, bonus credits, overages
- [**Kimi Code**](docs/providers/kimi.md) / session, weekly
- [**MiniMax**](docs/providers/minimax.md) / coding plan session
- [**OpenCode Go**](docs/providers/opencode-go.md) / 5h, weekly, monthly spend limits
- [**Devin**](docs/providers/devin.md) / weekly quota, extra usage
- [**Z.ai**](docs/providers/zai.md) / session, weekly, web searches

## Contributing

Community contributions are welcome. Add providers as plugins, keep changes focused, and include tests or screenshots when they fit the change.

- **Add A Provider.** See the [Plugin API](docs/plugins/api.md).
- **Fix A Bug.** Include the root cause, the fix, and a regression test when practical.
- **Request A Feature.** [Open an issue](https://github.com/cogine-ai/OpenUsageCN/issues/new) and make your case.

## Credits

OpenUsageCN is a fork and rebrand of OpenUsage. It is inspired by [CodexBar](https://github.com/steipete/CodexBar) by [@steipete](https://github.com/steipete).

## License

[MIT](LICENSE)

---

<details>
<summary><strong>Build From Source</strong></summary>

> **Warning**: The `main` branch may contain unreleased changes. Use tagged releases for stable builds once OpenUsageCN releases are published.

### Stack

...
