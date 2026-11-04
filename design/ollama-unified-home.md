# Ollama Unified Account Usage

## Goal And Direction

The user checks a small desktop panel to compare remaining allowance across personal and work
accounts before choosing where to run a model. The home page must show every readable connection,
including the existing Cookie/API Key/environment connection, independently of the primary.
Keep the existing quiet, compact interface: neutral surfaces, readable numbers and one usage bar
per quota window. Account identity leads each block; the primary badge is a secondary annotation.

Domain: provider, account, API Key, quota window, reset, purchased credits, primary connection.
Color world: existing white/graphite canvas, foreground ink, muted metadata, neutral quota bars,
amber for a connection requiring attention, red for exhausted allowance. Use current app tokens.
Signature: one provider heading followed by separate named account quotas; default selection never
hides sibling accounts. Avoid a provider-wide total, duplicate old/new provider cards, and a large
missing-credential alert for an unconfigured old connection while named accounts are available.

## Layout And Interaction

- Home has one Ollama Cloud heading, Manage Accounts and Refresh All actions. Keep the provider's
  order and enabled setting. Each connection has its own name, identity/source, plan, complete
  quota lines, purchased credits and last successful update time. No totals across connections.
- Use 4px spacing units, 12px account padding, 12px gaps, existing 10px corners, 14px account labels,
  12px supporting copy and tabular figures. Preserve existing theme tokens and progress semantics.
- Opening an account opens its own quota/detail/report page. Browsing and refreshing never select
  another primary. Provide a clear Back To Accounts control. Report requests target that connection.
- Management uses the same account list, including Original Connection as a normal entry. Editing
  that entry opens the existing configuration controls; no migration/copy/deletion of credentials.
- A configured old connection appears with its own quota/status in home and account list, even when
  a named connection is primary. An unconfigured old connection is offered in management, and is
  omitted from home if named connections exist. With no usable configured connections, show one
  Add Connection action. Never replace a healthy account with the old missing-credential warning.
- Rename the primary annotation to Primary with explanatory copy: Used By Menu Bar And Local API.
  It does not determine the home list, account availability or browsing. Keep explicit selection;
  never auto-select a newly added account. Preserve CLI/HTTP single-primary behavior.
- Temporary failure affects only its connection: show the friendly error and preserve its previous
  quota/time. Authentication or identity changes must clear invalid data only for that connection.
- Initial loading, list-read failure, empty list, configured old connection, expired key, pending
  refresh and partial failure must all have explicit states. Errors are visible and logged safely.
- Per-account refresh and Refresh All include the existing connection. Scheduled/global refresh
  updates the same independent account snapshots, not just the primary. Keep the configured auto
  update interval; no requests during render and no background reports load.
- Starting a connection's quota refresh clears/cancels that connection's reports, including failure.
  Other account reports remain independent. Changing credentials rejects older pending requests.

## Data And Isolation

Extend the masked account view with an independent old-connection snapshot/status/configured flag.
Store only its source/configuration digest, revision, safe output and update/error metadata; never
copy raw old secrets. Saved and environment credentials must follow the plugin's actual precedence.
Configuration changes clear this snapshot even if the menu/API primary is another account.
Refresh each connection with its own captured credential revision/identity and existing connection
lock. Use bounded total time including waiting, release the store lock before network work, and
never overwrite a newer credential or primary projection. Only a selected connection may publish
menu/API quota; sibling success or failure cannot replace it. Retain original success timestamps.

## Delivery Plan

1. Finish this design and the standalone visual specimen before product code changes.
2. Add independent old-connection state and all-account refresh behavior; cover generation changes,
   selected-source credentials, removed/replaced connections, partial failure and primary isolation.
3. Reuse one account presentation on home/provider pages; unify old-connection management and
   detail/report behavior. Add real production-page regressions for the reported empty home case.
4. Update README.md, docs/providers/ollama.md, docs/usage-history.md, docs/local-http-api.md and
   docs/cli.md. Keep technical design in this design document, not in user docs.
5. Validate native and frontend tests/build, audit plugin transport/log redaction, inspect 320/400/600px,
   light/dark, empty/partial-error states, then provide before/after screenshots and open one PR.

The user has approved this direction and implementation together. The specimen is synthetic design
only; production component screenshots and final behavior checks are separate delivery evidence.

## Implementation And Review

The masked account view now includes an independent original-connection snapshot. Its credentials
stay in the existing file/environment; only a configuration digest and safe quota metadata enter
the account cache. GUI refreshes use up to four workers, a shared 60-second execution budget and
30-second per-connection budgets including lock waits. CLI remains primary-only. Final GUI/CLI
publication reuses each selected row's persisted fetch time rather than writing the batch start
time into the cache. The native refresh command reuses its original deadline for its final view.

Home, provider details and management share the connection presentation. Original API Key reports
use an explicit `useLegacy` selector, and conflicting selectors are rejected. Connection refresh
events update the menu-bar projection from masked stored data without an extra provider request.
Pending projection reads are invalidated both on batch start and on events received during loading.

Independent source review identified and closed these boundaries:

- Original report settings and their validation stamp must come from one captured configuration;
  an environment change between captures must not authorize an older account's report.
- Final masked views must not grant fresh time budgets or run file/shell work on the async thread.
- Startup and warm CLI reads must check the original connection's current configuration before
  exposing a cached quota. Unknown or changed source credentials clear an unattributed old reading.
- An old menu-bar projection read must not restore the previous account after a replacement
  batch fails to start. New regression cases cover the skipped-loading-event and batch-start fences.

The plugin itself and its transport fields are unchanged. The added safe view contains source,
configured status, revision, quota, time and curated errors. Raw old secrets and configuration
digests are excluded from IPC. The selected runtime override uses existing `apiKey`/`cookieHeader`
fields covered by host redaction; saved and resolved environment secrets register with the existing
redactor. Legacy view/storage and existing Ollama log-redaction regressions cover this audit.

Final local validation: 2,221 JavaScript tests in 158 files; 689 Rust tests with 3 existing ignored;
production frontend build; Rust binary checks; changed Rust formatting and diff checks.
[Production component browser evidence](evidence/ollama-unified-home/README.md) records 32 checks,
before/after screenshots, light/dark modes and 320/400/600px widths. No installed application or
real account/provider acceptance is claimed. A single PR carries implementation, tests and docs.
