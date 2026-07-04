# Gemini

Tracks Gemini CLI quota from the Google Code Assist quota endpoint.

This plugin uses the Gemini CLI OAuth files already on the machine. It does not support Gemini API key or Vertex AI auth modes.

## Setup

1. Sign in with Gemini CLI using Google account auth.
2. OpenUsageCN will read `~/.gemini/oauth_creds.json`.
3. Enable the Gemini plugin.

If your Gemini config lives elsewhere, set `Gemini Config Dir` in Settings or use `GEMINI_CONFIG_DIR`.

OAuth files stay in the Gemini CLI config directory. If OpenUsageCN Settings are used for the config path, that path is stored in `~/.openusagecn/providers.json`.

## Displayed Lines

| Line       | Meaning                                          |
|------------|--------------------------------------------------|
| Pro        | Pro model quota used, shown as a percentage      |
| Flash      | Flash model quota used, shown as a percentage    |
| Flash Lite | Flash Lite model quota used, shown as a percentage |

The plan label is best effort: `Paid`, `Free`, or `Legacy` when the Code Assist setup response includes a known tier.

## Endpoint

The plugin requests:

```text
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
Authorization: Bearer <oauth_access_token>
```

If the local OAuth token is expired and the local credentials file includes refresh client data, the plugin refreshes through:

```text
POST https://oauth2.googleapis.com/token
```

If refresh data is unavailable, sign in with Gemini CLI again.

## Errors

| Condition             | Message                                                           |
|-----------------------|-------------------------------------------------------------------|
| No OAuth file         | "Gemini OAuth credentials not found. Sign in with Gemini CLI first." |
| Unsupported auth mode | "Gemini {auth} auth is not supported. Sign in with Gemini CLI Google account auth." |
| Expired session       | "Gemini OAuth token expired. Run Gemini CLI sign-in again."       |
| 401/403               | "Gemini OAuth session expired. Run Gemini CLI sign-in again."     |
| HTTP error            | "Usage request failed (HTTP {status}). Try again later."          |
| Invalid JSON          | "Usage response invalid. Try again later."                        |
