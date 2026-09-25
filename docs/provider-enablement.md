# Automatic Provider Enablement

OpenUsageCN checks local credentials once when it first sees a provider. On a fresh install, the existing Claude, Codex, and Cursor starter set remains on, and providers with detected credentials are added. After an update, the check runs only for providers that were not present in the saved provider order.

The current automatic checks cover DeepSeek, Moonshot, Ollama Cloud, Doubao, and xAI. They read only values saved in OpenUsageCN Settings and the same process or interactive-shell environment variables that provider plugins can read. The check makes no network request, does not read browser cookies, and does not test whether a key is still valid or has the required plan. The first regular refresh verifies access.

| Provider | Local evidence required |
| --- | --- |
| DeepSeek | API key |
| Moonshot | Key for the selected China Mainland or International region |
| Ollama Cloud | Explicit Cookie header containing an Ollama session cookie |
| Doubao | Volcengine Access Key ID and Secret Access Key |
| xAI | Management API key and valid Team ID |

An Ollama installation or `~/.ollama/id_ed25519` file does not prove access to Ollama Cloud. A model inference key does not replace Doubao AK/SK or an xAI Management API key.

The saved provider order records which providers this installation has already seen. Once a provider has been checked, the app will not turn it on again automatically. Manually turning a provider off always sticks. If you add credentials later, turn the provider on in Settings. If the local check fails, the app logs the error and does not save the new provider order during that startup, so the next launch can retry unless you change provider settings in the meantime.

Other providers keep their current defaults and manual switches. Their credential sources include provider-owned files, Keychain, and databases, which need separate provider-specific checks before automatic enablement can be added safely.
