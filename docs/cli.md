# Command-Line Tool

The global `openusage` command prints the same stable `openusage.limits.v1` JSON contract as `/v1/limits`. It runs independently, so the menu-bar app and local HTTP server do not need to be open.

## Install

Open Settings, find **命令行**, and choose **安装命令**. OpenUsageCN creates `/usr/local/bin/openusage` after macOS administrator approval. It never overwrites an existing file or link owned by another tool.

Move the app out of its DMG before installing. Installation is unavailable from a mounted volume or macOS App Translocation path because that link would stop working after the temporary app path disappears. If you later move the installed app, remove the old link manually before installing it again.

Removing the command only removes the exact link created for the installed app.

## Use

```bash
# All enabled providers
openusage

# One provider, including a provider disabled in Settings
openusage codex

# Refresh the selected scope even when its cache is still fresh
openusage codex --force
```

Standard output contains compact JSON only. Refresh diagnostics go to standard error, so scripts can parse stdout directly.

Without `--force`, snapshots newer than five minutes are reused. Missing or stale providers are refreshed with the same plugin engine, credentials, provider settings, and proxy configuration as the app. Successful results are written to the shared disk cache for later CLI runs and the app's next launch; an already-running app updates after its own refresh. A failed refresh does not replace the last successful snapshot.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Requested data was returned successfully |
| `2` | Invalid arguments or unknown provider id |
| `3` | At least one requested provider has no successful snapshot |
| `4` | A refresh or local read failed; JSON may still contain last-good data |

Use `openusage --help` for the command summary and `openusage --version` for the installed version.
