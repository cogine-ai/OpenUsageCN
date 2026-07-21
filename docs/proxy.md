# Proxy Configuration

OpenUsageCN can route provider and plugin HTTP requests through an optional proxy.

- Supported proxy types: `socks5://`, `http://`, `https://`
- macOS config: `~/.openusagecn/config.json`
- Windows config: `%LOCALAPPDATA%\ai.cogine.openusagecn\config.json`
- Default: off
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
- `localhost`, `127.0.0.1`, and `::1` always bypass the proxy.
- Missing, disabled, invalid, or unreadable config leaves proxying off.
- Proxy credentials are redacted in logs.
- Proxy credentials remain plaintext in this file. On Windows, normal user-profile permissions limit access, but other processes running as the same user can still read it.

## Scope

This applies to provider, plugin, and provider-status HTTP requests that go through OpenUsageCN's built-in HTTP client.

OpenUsageCN uses only this manual proxy configuration. It does not automatically use macOS or Windows system proxy settings, `HTTP_PROXY`-style environment variables, PAC/WPAD, or integrated enterprise proxy authentication. It also does not proxy unrelated subprocess network traffic.
