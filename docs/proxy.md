# Proxy Configuration

OpenUsageCN can route provider and plugin HTTP requests through an optional proxy.

- Supported proxy types: `socks5://`, `http://`, `https://`
- macOS config: `~/.openusagecn/config.json`
- Windows config: `%LOCALAPPDATA%\ai.cogine.openusagecn\config.json`
- Default: Windows uses its enabled fixed system proxy; other platforms are off
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
- A valid enabled manual proxy overrides the Windows system proxy.
- If no manual proxy is configured on Windows, OpenUsageCN follows the enabled fixed proxy in Windows system settings.
- Setting `enabled` to `false` forces direct connections.
- Invalid or unreadable config forces direct connections and writes a warning to the app log.
- Proxy credentials are redacted in logs.
- Proxy credentials remain plaintext in this file. On Windows, normal user-profile permissions limit access, but other processes running as the same user can still read it.

## Scope

This applies to provider, plugin, and provider-status HTTP requests that go through OpenUsageCN's built-in HTTP client.

Windows system proxy support covers enabled fixed proxy settings (`ProxyEnable` and `ProxyServer`). It does not support PAC/WPAD, the Windows proxy bypass list (`ProxyOverride`), or integrated enterprise proxy authentication. OpenUsageCN enforces its own loopback bypass instead. Other platforms do not automatically use system proxy settings. Unrelated subprocess network traffic is not proxied.

On Windows, `HTTP_PROXY`-style environment variables take priority over the fixed system proxy. A valid enabled manual config still takes priority over both.
