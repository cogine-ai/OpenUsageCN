# Ollama Cloud

Tracks your cloud account usage. Local model execution does not count toward these meters.

## Multiple Accounts And Keys

Open **Ollama Cloud → Manage Keys** to add independently named API Key connections. Each
connection shows the verified account, a masked key hint and its own quota update status.
Select a connection to view its quota, purchased credits and personal model reports.
Browsing a connection does not change the account shown on the home page or menu bar.
Reset countdowns update while the detail page is visible without requesting new quota data.

1. Choose **Add Key**, enter a name and an Ollama API Key, then verify it.
2. Check the returned account identity before confirming the save.
3. Use **Set As Primary** explicitly to show that connection on the home page and menu bar.

Adding a key does not replace or select the original connection automatically. The original
Cookie, single saved API Key and environment variables remain unchanged. **Other Connection
Methods** opens those existing settings; explicitly return to the original connection to use
them for the home page and menu bar again.

Updating a key verifies it before replacing the saved credential. A key belonging to a different
account must be confirmed as a new connection instead; it cannot overwrite the existing account.
An unsuccessful verification does not save the new key. Saved keys are never returned to the
interface in full. Renaming a connection does not change its identity or quota.

Removing a connection only removes it from OpenUsageCN; it does not revoke the key at Ollama.
Removing the primary connection leaves no primary selected. Choose another connection or return
to the original connection explicitly; the app does not switch accounts on its own.

Each connection has its own last successful quota and update time. A temporary network failure,
rate limit or permission error is shown separately and does not replace that connection's
successful data with zero or another account's quota. Changing a key or account invalidates
results still loading with the previous credential.
Refreshes waiting to run check the connection again before sending requests. Removing or
replacing a key prevents an older waiting refresh from starting a request with that key.

Ollama reports account usage, not spending attributable to an individual API Key. Multiple keys
for the same user may read the same balances; team members can also share balances. Connection
balances are displayed separately and are never added into an overall total.

## Choose A Source

These settings apply to the original connection. The existing **Cookie** source remains the default.
Select **API Key** explicitly to use the JSON endpoints and server reports. New named connections
always use their own API Key. A failed request never switches to another source or account.

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

For a named API Key connection, open that account's detail view and load **Server Reports** for
**7D** and **30D** model statistics. The original connection also offers these reports when its
API Key source is selected. Loading reports does not change the primary account. Cookie
connections do not provide these reports.

Reports cover the signed-in user’s own usage (`scope=self`), while team members may share the balances shown in quota. Reports show requests, input tokens, cached input tokens, output tokens, usage value and daily request charts where supplied. Cached input is already included in input tokens; do not add it again. Usage value is the service's reported dollar value, not proof of an additional billed charge. Model rows show the same units and are capped at the top 100 by reported requests, with an explicit partial result when truncated.

The windows use UTC. The server ranges cover the preceding 7 or 30 UTC days plus today so far; they may contain 8 or 31 daily buckets. Coverage lists the dates actually reported. Missing dates are not filled with zero. A remainder or incomplete model grouping keeps daily totals available but marks model breakdown incomplete.

Each window has its own availability state. A denied 30D report does not hide a readable 7D report.
Reports use the connection being viewed. Account identity, source and key are checked before
publishing the result; replacing or removing that connection discards a pending result. Switching
to another account clears the displayed reports and requires a fresh load. Reports never enter
another connection's quota cache.

## Storage And Errors

Settings secrets use the app's existing local `providers.json` storage. They are not encrypted at rest; another process running as the same user can read that file. Environment variables must be set before starting the app; fully exit and restart after changing them on Windows.

Named connections use a separate `ollama-accounts.json` beside `providers.json`. This file also
contains plaintext keys and should be treated as sensitive. Existing credentials are not moved
or rewritten when adding a named connection. Keys are masked in the interface and removed from
request and response logs.

- Missing credential: add the credential for the selected source.
- Expired verification: enter and verify the key again before confirming the save.
- API Key 401: check or replace the key. API Key 403: access was denied; check account permissions.
- Cookie redirect, 401 or 403: sign in again and copy a fresh Cookie header.
- Report permissions, rate limits and parse failures are shown separately. Error messages and plugin logs do not include raw account responses or credentials.
  Key verification and account operations retain the backend's friendly explanation, such as
  an expired confirmation or a partially completed refresh. Unexpected client errors use a
  generic message and are not displayed or logged with their raw contents.

Ollama documents the [balance endpoint](https://docs.ollama.com/api/balance) and [cloud usage reports](https://docs.ollama.com/api/cloud-usage). Plan information uses `/api/me`, following [OpenUsage's fixed implementation](https://github.com/robinebers/openusage/tree/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Ollama).
