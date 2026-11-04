# Ollama Cloud

Tracks your cloud account usage. Local model execution does not count toward these meters.

## Choose A Source

The existing **Cookie** source remains the default. Select **API Key** explicitly to use the JSON endpoints and server reports. A failed request never switches to the other source or account.

### Cookie

1. Sign in at [Ollama settings](https://ollama.com/settings).
2. In your browser developer tools, copy the `Cookie` request header from an `ollama.com/settings` request.
3. Paste it into **Settings → Ollama Cloud → Cookie Header**, then enable the provider.

You can set `OLLAMA_CLOUD_COOKIE` instead; Settings takes priority. The app does not import browser cookies automatically or use `~/.ollama/id_ed25519`.

This source reads the settings page and shows the **Monthly**, **Session**, or **Weekly** windows present there. For example, `$7.50 of $60 used` appears as 12.5%. Reset times come from the page. The page format is undocumented and can change.

### API Key

1. Create an API key at [Ollama keys](https://ollama.com/settings/keys).
2. Select **API Key** in the provider's source setting.
3. Enter the key, or set `OLLAMA_API_KEY`, then refresh usage.

Settings takes priority over the environment. The plugin reads JSON balance data and optional account plan information. The key is a normal Ollama API key; the app does not claim that the key itself is restricted to reading usage.

- **Monthly** shows dollar usage against the returned allowance, with the actual billing-period reset and duration.
- Legacy **Session** and **Weekly** percentages appear when returned.
- **Purchased Credits** shows the separate available dollar balance. It is not added to the monthly allowance. If the service returns a valid monthly period with a zero included allowance, the purchased balance remains visible without a zero-limit Monthly bar.

If the balance request succeeds but account plan details are denied, unavailable or malformed, quota and purchased balance remain visible. **Account Details: Unavailable** explains that the plan badge could not be loaded, and the app logs a fixed warning. It does not try another credential. Reports still require a successful identity check before and after loading; unavailable account identity cannot be bypassed.

## Server Reports

With the API Key source selected, open **Server Reports** in the provider detail view to load **7D** and **30D** model statistics. Loading reports does not block quota refresh. Cookie connections do not provide these reports.

Reports cover the signed-in user’s own usage (`scope=self`), while team members may share the balances shown in quota. Reports show requests, input tokens, cached input tokens, output tokens, usage value and daily request charts where supplied. Cached input is already included in input tokens; do not add it again. Usage value is the service's reported dollar value, not proof of an additional billed charge. Model rows show the same units and are capped at the top 100 by reported requests, with an explicit partial result when truncated.

The windows use UTC. The server ranges cover the preceding 7 or 30 UTC days plus today so far; they may contain 8 or 31 daily buckets. Coverage lists the dates actually reported. Missing dates are not filled with zero. A remainder or incomplete model grouping keeps daily totals available but marks model breakdown incomplete.

Each window has its own availability state. A denied 30D report does not hide a readable 7D report. Account identity, source and key are checked before publishing the result; a change discards it and asks for a refresh.

## Storage And Errors

Settings secrets use the app's existing local `providers.json` storage. They are not encrypted at rest; another process running as the same user can read that file. Environment variables must be set before starting the app; fully exit and restart after changing them on Windows.

- Missing credential: add the credential for the selected source.
- API Key 401: check or replace the key. API Key 403: access was denied; check account permissions.
- Cookie redirect, 401 or 403: sign in again and copy a fresh Cookie header.
- Report permissions, rate limits and parse failures are shown separately. Error messages and plugin logs do not include raw account responses or credentials.

Ollama documents the [balance endpoint](https://docs.ollama.com/api/balance) and [cloud usage reports](https://docs.ollama.com/api/cloud-usage). Plan information uses `/api/me`, following [OpenUsage's fixed implementation](https://github.com/robinebers/openusage/tree/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Ollama).
