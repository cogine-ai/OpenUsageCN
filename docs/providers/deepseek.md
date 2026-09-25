# DeepSeek

Shows your DeepSeek API account balance. It does not show chat app usage, model prices, or per-day API cost history.

## Setup

1. Create an API key in the [DeepSeek Platform](https://platform.deepseek.com/).
2. Open OpenUsageCN Settings and enter it in the DeepSeek `API Key` field.
3. Enable DeepSeek in Settings.

If a key is already available when DeepSeek first appears, the [one-time startup check](../provider-enablement.md) can enable it automatically. Adding a key later requires the manual switch.

The Settings key takes priority. If that field is empty, the plugin reads `DEEPSEEK_API_KEY` from the app's environment. Set the variable before starting the desktop app; a variable set in an unrelated terminal is not visible to an already-running app.

Keys entered in Settings are stored as plaintext in the app's `providers.json` file under your user profile. Other processes running as your user can read that file.

## Displayed Data

- **API Access** follows DeepSeek's `is_available` flag. It can say **Unavailable** even when a balance is shown.
- **CNY Balance** and **USD Balance** show each currency returned by the API. The plugin never adds different currencies together.
- **Granted** is unexpired promotional credit. **Topped Up** is paid credit. Both appear in the detail view for each returned currency.
- A zero balance displays as `¥0.00` or `$0.00`. If DeepSeek reports no balance entries and `is_available` is false, only **API Access** appears.

These are provider-reported remaining balances, not a percentage of a fixed quota. There is no maximum or reset date to show.

## Endpoint

The plugin requests the [official balance API](https://api-docs.deepseek.com/api/get-user-balance/):

```text
GET https://api.deepseek.com/user/balance
Authorization: Bearer <api_key>
```

The response includes `is_available` and `balance_infos[]`. Each balance entry has `currency`, `total_balance`, `granted_balance`, and `topped_up_balance`. DeepSeek documents CNY and USD balances. The plugin does not send usage or generation requests.

## Errors

| Condition | Message |
|-----------|---------|
| No key | "No DeepSeek API key found. Add it in Settings or set DEEPSEEK_API_KEY." |
| 401/403 | "DeepSeek API key invalid. Check your API key." |
| Other HTTP error | "Balance request failed (HTTP {status}). Try again later." |
| Network error | "Balance request failed. Check your connection." |
| Invalid response | "Balance response invalid. Try again later." |

Failures are logged without the API key. The app retains its last successful snapshot when a refresh fails.
