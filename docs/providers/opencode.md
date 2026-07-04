# OpenCode

Tracks opencode.ai web subscription quota.

This plugin is separate from OpenCode Go. OpenCode reads the web dashboard subscription usage; OpenCode Go reads local usage history from the Go tool.

## Setup

1. Open `https://opencode.ai` in a browser while signed in.
2. Copy the request Cookie header manually.
3. Open OpenUsageCN Settings and paste it into `Cookie Header`.
4. Optionally set `Workspace ID` with a `wrk_...` ID or an OpenCode workspace URL.
5. Enable the OpenCode plugin.

The Settings value is used first. If it is empty, `OPENCODE_COOKIE` is used.
`OPENCODE_WORKSPACE_ID` is supported for the optional workspace selection.

Cookie values entered in Settings are stored as plaintext in `~/.openusagecn/providers.json`, protected only by best-effort private file permissions (`0600` on macOS/Linux; on Windows, use profile-local storage and OS account permissions to restrict access).

## Displayed Lines

| Line    | Meaning                                  |
|---------|------------------------------------------|
| Session | Rolling 5-hour web subscription usage    |
| Weekly  | Weekly web subscription usage            |
| Renews  | Renewal date, when returned              |

## Endpoint

The plugin requests the opencode.ai server functions used by the web dashboard:

```text
GET https://opencode.ai/_server?id=<workspaces_server_id>
GET https://opencode.ai/_server?id=<subscription_server_id>&args=["wrk_..."]
```

If `Workspace ID` is configured, the workspace discovery request is skipped.

## Errors

| Condition       | Message                                                    |
|-----------------|------------------------------------------------------------|
| No Cookie       | "No OpenCode cookie found. Add it in Settings or set OPENCODE_COOKIE." |
| Expired session | "OpenCode session expired. Copy a fresh opencode.ai Cookie header." |
| No workspace    | "OpenCode workspace ID not found. Add the Workspace ID in Settings." |
| HTTP error      | "OpenCode request failed (HTTP {status}). Try again later." |
| Invalid payload | "OpenCode response missing subscription usage fields."      |
