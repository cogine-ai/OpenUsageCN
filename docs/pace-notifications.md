# Quota Pace Notifications

> macOS only. Quota pace notifications are not available in the Windows MVP.

OpenUsageCN can send macOS notifications when a provider's quota gets worse during the current reset window.

The three alerts are:

- **即将用尽** — less than 10% remains.
- **接近上限** — the current pace is projected to finish close to the limit.
- **预计提前用尽** — the current pace is projected to exhaust the quota before reset.

All alerts are off by default. Enable only the alerts you want in Settings. The first enabled alert asks for macOS notification permission. System notifications require a macOS `.app` build; a bare `bun tauri dev` executable keeps running for development but reports notifications as unavailable.

The first reading after launch establishes a baseline and does not notify. A continuing bad state is not repeated. Recovery or a real quota reset allows a later worsening to notify again. Disabled providers do not send alerts.

If macOS permission is denied, use the Settings button to open System Settings. A failed delivery is logged and retried on a later evaluation instead of being marked as sent.
