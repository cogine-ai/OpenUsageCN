# Usage History

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

Failed or incomplete refreshes keep the previous successful result, marked **Stale**. Removing
an account clears its quota and model-usage caches and all its connections in OpenUsageCN.
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

## Export CSV

The download icon (**Export CSV**) saves the currently displayed cached result to your Downloads folder. The app shows the actual
saved path, or an error if it could not write the file. Every export has a generated filename and
cannot overwrite an existing file.

The CSV includes source, account ID, billing dates when known, actual coverage, fetch time, time
zone, and pagination status. Times labeled UTC use UTC; model detail dates use the recorded time
zone. The window summary contains metered usage once. Daily model rows contain token counts,
request counts, and known list-price equivalents with their coverage status. Missing amounts stay
blank, and metered usage is not assigned to individual models.

Commas, quotes, and line breaks in model names are escaped. Names that could be interpreted as
spreadsheet formulas receive a visible `Text:` prefix followed by a space in the CSV; the cached
result retains the original name. This avoids relying only on quote escaping when a spreadsheet saves the CSV again.
