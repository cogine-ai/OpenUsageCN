# Usage History

Cursor's shared weekly allowance and separate Grok Bot allowance are quota windows, not monthly
billing periods. Model Usage keeps the verified monthly period when available; otherwise it uses
the existing bounded 30-day window. A weekly reset does not turn the model history into a weekly report.

The Cursor Models, Other Models and Grok Bot quota bars are current allowances with their own
reset dates. They are separate from the model-usage cache described below; weekly Grok Bot
allowance is not calculated from cached events or added to monthly Total.

## Cursor Usage Cache

Open Cursor's account detail page to load **Model Usage**. Each account keeps only its latest
successful result as a local cache. A successful refresh replaces the entire result, even when
dates overlap or the billing period changes. Results are never added together or compared with
older local windows.

Fetches cover the current billing cycle, capped to the latest 30 days. Without reliable billing
dates, they cover a bounded 30-day interval. Actual coverage dates appear beside the export icon;
receiving all requested pages does not mean a full billing cycle or a complete invoice.
The data notes include the update time and time zone.

Each refresh has a 60-second budget, including time waiting for another history refresh.
Identity checks and page requests use only the time left, with at most 30 seconds per request.
Timed-out, failed, or incomplete refreshes report a failure and keep the previous successful
result, marked **Stale**. Partially fetched pages are never saved.

Removing an account clears its quota and model-usage caches and all its connections in OpenUsageCN.
Other accounts remain unaffected. Adding that account again fetches fresh data; it does not
restore the old cache. Removing one browser connection leaves the account and its cache intact.
Neither action signs out of Cursor, its CLI, or the browser.
If removal reports a cache-cleanup failure, retry on the same page after resolving the file-access
problem. Closing the page loses this retry control; the account remains removed, but leftover
files may need manual cleanup.

Older saved files remain readable, but only their latest result is used. The next successful save
replaces the file with a single cached result. Earlier windows cannot be selected or exported.
Damaged recognized files are preserved with an `.invalid` suffix and an error is reported.
Unsupported or unreadable files remain in place with an error until the problem is resolved.

Model rows show total tokens, requests and list-price equivalents. Expand a model to see its
input, output and cache counts. Metered usage and list-price equivalents have separate meanings;
these dashboard figures are not invoices.

**On-Demand Charges** includes only events explicitly marked as usage-based and chargeable.
If classification or an amount is missing, **Known On-Demand Charges** is a subtotal marked
**Incomplete**, with the unclassified event count in the data notes. It is never substituted for
Metered Usage or List-Price Equivalent. **Usage Events** counts valid events in the window,
including events without tokens; the existing Requests count still requires token usage.
Older caches show the new fields as unavailable until refreshed.

## Export CSV

The download icon (**Export CSV**) saves the currently displayed cached result to your Downloads folder. The app shows the actual
saved path, or an error if it could not write the file. Every export has a generated filename and
cannot overwrite an existing file.

The CSV includes source, account ID, billing dates when known, actual coverage, fetch time, time
zone, and pagination status. Times labeled UTC use UTC; model detail dates use the recorded time
zone. The window summary contains metered usage once. Daily model rows contain token counts,
request counts, and known list-price equivalents with their coverage status. Missing amounts stay
blank, and metered usage is not assigned to individual models.

Four columns are appended: Usage Events, Known On-Demand Charges USD, On-Demand Coverage,
and Unclassified Events. They belong to the window summary; model rows leave them blank.
Unavailable legacy classification stays blank with Unavailable coverage, rather than zero.

Commas, quotes, and line breaks in model names are escaped. Names that could be interpreted as
spreadsheet formulas receive a visible `Text:` prefix followed by a space in the CSV; the cached
result retains the original name. This avoids relying only on quote escaping when a spreadsheet saves the CSV again.

## Server Reports

Codex, OpenRouter and Ollama detail pages offer **Load Reports** independently of quota refresh.
Reports use the current connection and are not added to local log estimates or Cursor caches.
They show each report's access status, UTC date coverage and missing dates. A missing day is not
treated as zero; one denied report does not hide another readable report. Refresh replaces the
displayed result. Closing the page, changing connection settings or starting a new request
invalidates an older pending result. Starting a main quota refresh also clears loaded reports and
cancels pending reports, so new quota cannot retain a previous login's report. Load Reports stays
disabled during the quota refresh; load it again afterward, even if the quota refresh failed.
Reports are not saved as long-term history.
Displayed reports are snapshots from their shown update time. External login changes are not
watched automatically; refresh the main quota and load reports again after switching a login.

- Codex reads the current ChatGPT user's daily tokens/turns and supported workspace charged credits.
  Negative credit adjustments retain their sign. Charged credits are not dollars. It does not
  refresh or write login credentials; if access expires, refresh the existing quota connection and retry.
- OpenRouter Activity requires a management Key and covers the previous 30 completed UTC days.
  Account Activity can have a broader scope than Listed Keys Spend; the two totals stay separate.
  BYOK is separate from platform spend.
- Ollama API Key reports provide 7d and 30d server windows with model totals. The service may include
  today's bucket as well as the preceding days. Cookie-only connections retain their existing quota
  behavior and explain why JSON reports require the API Key source.
  Named API Key connections load reports for the account currently being viewed, independently of
  the primary account shown on the home page and menu bar. Switching the viewed account clears
  displayed reports. Replacing or removing its key invalidates pending reports, even if a request
  finishes successfully afterward. Quota caches and reports are never combined across connections.
  An app-level or scheduled quota refresh clears and cancels reports when viewing the primary
  connection, including failed refreshes. Reports for another viewed connection remain available.
  These are account statistics; multiple keys do not establish independent spending or allowances.

The requests have a 60-second host limit; individual providers can use a shorter budget.
Windows can read these server reports even though local ccusage history remains unavailable there.
