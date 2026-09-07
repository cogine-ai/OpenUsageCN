# Usage History

## Cursor Recorded Windows

Open Cursor's account detail page to load **Model Usage**. OpenUsageCN records successful results
for the selected account and keeps the latest 12 windows. Each billing cycle has one record; a
newer refresh replaces that record without counting overlapping usage twice.

- **Recorded Windows** selects an earlier local result. Choosing it does not refresh old accounts
  or fetch missing historical data.
- **Latest** is the newest recorded result, even when a failed refresh leaves it marked **Stale**.
- **Stored Window** identifies an earlier result you selected.
- **Unknown Billing Period** identifies a result without reliable billing dates, including older
  saved data. Existing data remains readable when updating the app.

The billing dates and actual coverage dates are separate. Fetches cover at most 30 days and may
cover only part of a billing cycle. **Complete Pages** confirms that all requested pages were
received. It does not mean a full billing cycle or a complete invoice.

Failed or incomplete refreshes keep the previous complete record. If saved history cannot be
read, the app reports the problem and preserves the file.

## Comparing Windows

The selected result is shown beside the previous recorded window. Percentage changes require the
same account, session-visible source, time zone, covered duration, and position within the billing
cycle. Different coverage is labeled **Cannot Compare**; the amounts remain visible side by side.

List-price equivalent and metered usage keep their separate meanings. A cost percentage requires
complete amounts on both sides. A zero previous value never produces a percentage. These figures
come from Cursor dashboard records and are not invoices.

## Export CSV

**Export CSV** saves the selected stored result to your Downloads folder. The app shows the actual
saved path, or an error if it could not write the file. Every export has a generated filename and
cannot overwrite an existing file.

The CSV includes source, account ID, billing dates when known, actual coverage, fetch time, time
zone, and pagination status. Times labeled UTC use UTC; model detail dates use the recorded time
zone. The window summary contains metered usage once. Daily model rows contain token counts,
request counts, and known list-price equivalents with their coverage status. Missing amounts stay
blank, and metered usage is not assigned to individual models.

Commas, quotes, and line breaks in model names are escaped. Names that could be interpreted as
spreadsheet formulas receive a visible `Text: ` prefix in the CSV; the saved history retains the
original name. This avoids relying only on quote escaping when a spreadsheet saves the CSV again.
