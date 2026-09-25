# Ollama Cloud

Tracks the cloud usage shown in your Ollama account. Running models locally does not count toward this plugin's meters.

## Setup

1. Sign in at [Ollama settings](https://ollama.com/settings).
2. In your browser's developer tools, copy the `Cookie` request header from an `ollama.com/settings` request.
3. Paste it into OpenUsageCN Settings under **Ollama Cloud → Cookie Header**, then enable the provider.

If a session Cookie is already configured when Ollama Cloud first appears, the [one-time startup check](../provider-enablement.md) can enable it automatically. Adding the Cookie later requires the manual switch.

You can set `OLLAMA_CLOUD_COOKIE` instead. The Settings value takes priority. An Ollama API key or the local `~/.ollama/id_ed25519` file alone is not used by this plugin to read account usage. This plugin cannot import browser cookies automatically. Settings secrets are stored as plaintext in the local `providers.json` file, which another process running as the same user can read. On Windows, set the environment variable before starting the app, then fully exit and restart it.

## Displayed Usage

The plugin reads `GET https://ollama.com/settings` with the browser session, as CodexBar does. It shows only usage blocks present on that page: **Monthly** on current credit plans, and **Session** or **Weekly** where those still apply. A page value such as `$7.50 of $60 used` appears as 12.5% used. If the page includes a reset time, the plugin shows it. It does not estimate a dollar balance or combine cloud usage with local model usage.

Ollama's [current pricing](https://ollama.com/pricing) gives new plans monthly usage credits and no session or weekly limit. Existing subscribers may remain on a legacy plan until they change their plan. The settings page markup is undocumented and may change.

## Errors

- No Cookie header: add one in Settings or set `OLLAMA_CLOUD_COOKIE`.
- Redirect, 401, or 403: sign in again and copy a fresh Cookie header.
- Usage blocks missing or changed: check the account usage page and update OpenUsageCN.
