# 更新日志

## 未发布

暂无。

## v0.6.29

### New Features

- Add local HTTP API health reporting and Settings status display ([#10](https://github.com/cogine-ai/OpenUsageCN/pull/10)) by @lc708

### Bug Fixes

- Harden local HTTP API CORS, loopback host validation, bind failure status, and cache readiness handling ([#10](https://github.com/cogine-ai/OpenUsageCN/pull/10)) by @lc708

### Chores

- Align agent icon guidance with the current project rules ([#9](https://github.com/cogine-ai/OpenUsageCN/pull/9)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.28...v0.6.29](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.28...v0.6.29)

- [1d03325](https://github.com/cogine-ai/OpenUsageCN/commit/1d033255610e31dd7e8e186d2d0b70963c89538c) Merge pull request #10 from cogine-ai/cliq/local-http-api-hardening by @lc708
- [9360c75](https://github.com/cogine-ai/OpenUsageCN/commit/9360c75d0858fed3e50f1a7f160e4480c6c553c1) Fix local API review follow-ups by @lc708
- [e1f7a1e](https://github.com/cogine-ai/OpenUsageCN/commit/e1f7a1e6f077b04ab19ce5bf17777895b2c0ffee) Tighten local HTTP API CORS by @lc708
- [02ac01e](https://github.com/cogine-ai/OpenUsageCN/commit/02ac01ed16a812900b2cc023d0d42ae7a050fe73) Harden local HTTP API diagnostics by @lc708
- [5daff29](https://github.com/cogine-ai/OpenUsageCN/commit/5daff2938312d99c86576b2f7717cfd52dafc4f5) Merge pull request #9 from cogine-ai/cliq/lucide-icon-rule by @lc708
- [ad1a97b](https://github.com/cogine-ai/OpenUsageCN/commit/ad1a97bc31e408fa6f89c5bd5782efc602623dcf) Align icon guidance with lucide by @lc708

## v0.6.28

### New Features

- Localize app UI copy to Chinese ([#3](https://github.com/cogine-ai/OpenUsageCN/pull/3)) by @lc708
- Add BigModel CN provider plugin with Settings API key support ([#4](https://github.com/cogine-ai/OpenUsageCN/pull/4)) by @lc708
- Add provider Settings config fields for plugin-declared values ([#6](https://github.com/cogine-ai/OpenUsageCN/pull/6)) by @lc708
- Add Z.ai Settings API key support with environment fallback ([#7](https://github.com/cogine-ai/OpenUsageCN/pull/7)) by @lc708

### Bug Fixes

- Stabilize the ccusage timeout cleanup test by @lc708

### Chores

- Initialize OpenUsageCN by Cogine AI
- Prepare release identity and repository docs ([#5](https://github.com/cogine-ai/OpenUsageCN/pull/5)) by @lc708
- Verify updater signatures before publishing release assets ([#5](https://github.com/cogine-ai/OpenUsageCN/pull/5)) by @lc708
- Gate release publishing on updater checks ([#5](https://github.com/cogine-ai/OpenUsageCN/pull/5)) by @lc708

---

### Changelog

Initial OpenUsageCN release from the current repository history.

- [4c13db1](https://github.com/cogine-ai/OpenUsageCN/commit/4c13db1f005caf1c504e7801872c2645a7d9a526) chore: initialize OpenUsageCN by Cogine AI
- [ad4cd25](https://github.com/cogine-ai/OpenUsageCN/commit/ad4cd2550e7c378c6df23fd452996418fd334fbb) Stabilize ccusage timeout cleanup test by @lc708
- [88b69c1](https://github.com/cogine-ai/OpenUsageCN/commit/88b69c10d47db047889c6a6278edb24b1b7a870d) Localize app UI copy to Chinese by @lc708
- [a093b16](https://github.com/cogine-ai/OpenUsageCN/commit/a093b16e0b628a5bdfe1afcc20b25abb60395d99) Add BigModel CN provider plugin by @lc708
- [e536d35](https://github.com/cogine-ai/OpenUsageCN/commit/e536d35af59825d99900b2a766e68f98abbaf7ce) Prepare release identity and repository docs by @lc708
- [d4ea5eb](https://github.com/cogine-ai/OpenUsageCN/commit/d4ea5eba9cbebaf9b561b6d7ff080e3bc5b93b95) Verify updater signatures before release by @lc708
- [90feb2e](https://github.com/cogine-ai/OpenUsageCN/commit/90feb2e2d4f69b3640422fca8b94a77886b61f3c) Add provider config fields by @lc708
- [a07d04d](https://github.com/cogine-ai/OpenUsageCN/commit/a07d04dc9a31998e76bfd64957d34a3d4e6dc8aa) Add Z.ai provider config field by @lc708

## 项目来源

OpenUsageCN 基于 OpenUsage fork，并面向中文本地化使用场景继续维护。
