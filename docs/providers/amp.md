# Amp

## Overview

- **Protocol:** JSON-RPC (`POST /api/internal`)
- **URL:** `https://ampcode.com/api/internal`
- **Auth:** API key from Amp CLI (`~/.local/share/amp/secrets.json`)
- **Tier:** Free (daily replenishing quota), paid subscriptions (Other/Orb usage), and individual credits

## Authentication

### Credential Source

The plugin reads the API key automatically from `~/.local/share/amp/secrets.json`, created by Amp CLI when you sign in. No manual setup required.

```json
{
  "apiKey@https://ampcode.com/": "sgamp_user_..."
}
```

The key is sent as `Authorization: Bearer <key>` to the JSON-RPC API.

## Data Source

### API Endpoint

```
POST https://ampcode.com/api/internal
Authorization: Bearer <api_key>
Content-Type: application/json

{"method": "userDisplayBalanceInfo", "params": {}}
```

### Response

The response contains a `displayText` string whose contents vary by user tier:

**Free tier + credits:**
```
Signed in as <user>
Amp Free: $<remaining>/$<total> remaining (replenishes +$<rate>/hour) [optional: +N% bonus for N more days] - https://ampcode.com/settings#amp-free
Individual credits: $<credits> remaining - https://ampcode.com/settings
```

**Paid credits only:**
```
Signed in as <user>
Individual credits: $<credits> remaining - https://ampcode.com/settings
```

**Paid subscription:**
```
Signed in as <user>
Subscription Megawatt: 97% other usage and 100% orb usage remaining - resets upon renewal in 29 days
```

The plugin parses the display text with regex to extract:
- **Balance:** `$remaining/$total remaining` → dollar amounts (only if Amp Free enabled)
- **Rate:** `replenishes +$rate/hour` → replenishment speed (only if Amp Free enabled)
- **Bonus:** `[+N% bonus for N more days]` → optional promotional bonus 
- **Credits:** `Individual credits: $N remaining` → paid credits balance
- **Subscription:** Plan name and the remaining percentages for Other Usage and Orb Usage. Both percentages must be finite and between 0 and 100.
- **Renewal:** Reported whole days, shown only as an approximate hint such as `约 29 天`.

Unrecognized usage fails visibly instead of becoming `Credits $0.00`. An explicit `Individual credits: $0 remaining` still shows a valid zero balance for a credits-only account. A malformed subscription line fails even if the response also contains a credits line.

### Usage Calculation (Free tier only)

- **Used:** `total - remaining` (clamped to 0 minimum)
- **Reset time:** `used / hourlyRate` hours from now (null if nothing used or rate is zero)
- **Period:** 24 hours (fixed)

### Paid Subscription Usage

- **Used:** `100 - remaining percent`, with a limit of 100. Fractional percentages are preserved.
- **Renewal:** A days-only hint is not an exact reset time. Paid bars do not publish `resetsAt` or a guessed billing-period duration, so they do not show a pace based on those guesses.
- **Credits:** Positive individual credits can appear beside subscription usage. A zero credits line is omitted when subscription usage is available.

The supported subscription format comes from [published Amp usage output](https://github.com/steipete/CodexBar/issues/2435). The internal API's display text can change; it is not a stable structured subscription contract.

## Plan Detection

| Condition | Plan |
|-----------|------|
| Subscription line present | Reported plan name, such as `"Megawatt"` |
| Free tier present (with or without credits) | `"Free"` |
| Credits only (no free tier) | `"Credits"` |

## Displayed Lines

| Line       | Scope    | Condition                   | Description                            |
|------------|----------|-----------------------------|----------------------------------------|
| Other Usage | overview | Paid subscription          | Other usage consumed as a percent bar |
| Orb Usage  | overview | Paid subscription           | Orb usage consumed as a percent bar |
| Renews     | detail   | Subscription renewal days reported | Approximate renewal hint |
| Free       | overview | Amp Free enabled            | Dollar amount consumed as progress bar |
| Bonus      | detail   | Amp Free + active promotion | Bonus percentage and duration          |
| Credits    | overview | Credits > $0, or credits-only accounts | Individual credits balance      |

The Free progress line includes:
- `resetsAt` — ISO timestamp of estimated full replenishment (null if nothing used or rate is zero)
- `periodDurationMs` — 24 hours for pace tracking

## Errors

| Condition              | Message                                                        |
|------------------------|----------------------------------------------------------------|
| Amp not installed      | "Amp not installed. Install Amp Code to get started."          |
| 401/403                | "Session expired. Re-authenticate in Amp Code."               |
| Non-2xx with detail    | Error message from API response                                |
| Non-2xx without detail | "Request failed (HTTP {status}). Try again later."             |
| Unparseable response   | "Could not parse usage data."                                  |
| Network error          | "Request failed. Check your connection."                       |

Parse failures log a fixed diagnostic message without copying the signed-in account text from `displayText`.
