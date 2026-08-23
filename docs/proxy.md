# Proxy Configuration

OpenUsageCN can route provider and plugin HTTP requests through an optional proxy.

- Supported proxy types: `socks5://`, `http://`, `https://`
- macOS config: `~/.openusagecn/config.json`
- Windows config: `%LOCALAPPDATA%\ai.cogine.openusagecn\config.json`
- Default: environment proxy variables, native macOS/Windows proxy settings, then direct
- UI: none

## Config File

Create the config file for your platform. On Windows, create the `ai.cogine.openusagecn` folder first if it does not exist.

```json
{
  "proxy": {
    "enabled": true,
    "url": "socks5://127.0.0.1:10808"
  }
}
```

You can also use an authenticated proxy URL:

```json
{
  "proxy": {
    "enabled": true,
    "url": "http://user:pass@proxy.example.com:8080"
  }
}
```

## Behavior

- Config is loaded once when the app starts.
- Restart OpenUsageCN after changing the file.
- A valid enabled manual proxy overrides automatic proxy discovery.
- Manual proxies always bypass `localhost`, `127.0.0.1`, and `::1`.
- Without a valid enabled manual proxy, OpenUsageCN first honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`.
- On macOS and Windows, native static HTTP/HTTPS proxy settings are used when the matching environment proxy variable is absent.
- Requests are direct when no environment or native system proxy applies.
- Proxy credentials are redacted in logs.
- Proxy credentials remain plaintext in this file. On Windows, normal user-profile permissions limit access, but other processes running as the same user can still read it.

## Scope

This applies to provider, plugin, provider-status, browser-account validation, Claude membership enrichment, and Cursor model-history requests that go through OpenUsageCN's built-in HTTP client.

OpenUsageCN does not support PAC/WPAD or integrated enterprise proxy authentication. It also does not proxy unrelated subprocess network traffic.
