# Compact Accounts Review Evidence

The before screenshot renders source from `26716ab`; the after screenshot renders this branch.
Both use the same synthetic quota/account/model-usage fixtures, the real provider-detail
components and their respective production CSS. No credentials or real account data are used.

- `cursor-before.png`: original expanded accounts with repeated connection details.
- `cursor-after.png`: default collapsed account summary and compact latest-usage/export row.

The harness uses a fixed 690px panel to compare component density. These screenshots do not
verify native Tauri window sizing, real provider responses, Keychain access or packaged-app behavior.
The viewport outside the panel differs; the panel width and fixtures are identical.
