# 更新日志

## 未发布

暂无。

## v0.6.31

### New Features

- Collapse configurable provider settings cards with compact config status labels and checkbox-only enable toggles ([#65](https://github.com/cogine-ai/OpenUsageCN/pull/65)) by @lc708

### Bug Fixes

- Align provider config status docs/tests and avoid duplicate config-load IPC when expanding provider settings ([#65](https://github.com/cogine-ai/OpenUsageCN/pull/65)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.30...v0.6.31](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.30...v0.6.31)

- [128b2b3](https://github.com/cogine-ai/OpenUsageCN/commit/128b2b359a257ffe7c809ad1ea5a9387bf969c07) Merge pull request #65 from cogine-ai/cliq/release-0.6.30 by @lc708
- [ab42036](https://github.com/cogine-ai/OpenUsageCN/commit/ab420364ab419c507a1588f699099257ba1c4eff) fix: address provider settings review comments by @lc708
- [e059be2](https://github.com/cogine-ai/OpenUsageCN/commit/e059be2e34fd7fca02a54803ba1ab0f854c06657) feat: collapse provider settings cards by @lc708

## v0.6.30

### New Features

- Add single-instance guard and refresh backoff ([#20](https://github.com/cogine-ai/OpenUsageCN/pull/20)) by @lc708
- Add CodexBar gap provider plugins for Alibaba Coding Plan, Alibaba Token Plan, Gemini, OpenAI API, OpenCode, and OpenRouter ([#58](https://github.com/cogine-ai/OpenUsageCN/pull/58)) by @lc708

### Bug Fixes

- Fix provider config data loss after degraded load and return error results when plugins panic ([#27](https://github.com/cogine-ai/OpenUsageCN/pull/27)) by @app/cursor
- Label provider config toggles and avoid duplicated short secret hints ([#33](https://github.com/cogine-ai/OpenUsageCN/pull/33)) by @app/cursor
- Block provider config saves when disk config is unrecoverable ([#44](https://github.com/cogine-ai/OpenUsageCN/pull/44)) by @app/cursor

### Chores

- Expand local HTTP API security edge and refresh failure coverage ([#28](https://github.com/cogine-ai/OpenUsageCN/pull/28)) by @app/cursor
- Cover provider config UI, plugin config validation, and probe error state handling ([#33](https://github.com/cogine-ai/OpenUsageCN/pull/33)) by @app/cursor
- Clarify provider config recovery saves ([#44](https://github.com/cogine-ai/OpenUsageCN/pull/44)) by @app/cursor

---

### Changelog

**Full Changelog**: [v0.6.29...v0.6.30](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.29...v0.6.30)

- [2d3b600](https://github.com/cogine-ai/OpenUsageCN/commit/2d3b600406a9f67a96043c0a654a748d496b9af1) Merge pull request #11 from cogine-ai/cliq/release-0.6.29 by @lc708
- [c5ca1e3](https://github.com/cogine-ai/OpenUsageCN/commit/c5ca1e3233d68d7aef711263c0ae3b9a6166b3a3) Add single instance guard and refresh backoff by @lc708
- [54875ad](https://github.com/cogine-ai/OpenUsageCN/commit/54875ad288f4b4590ec16676bd159afab2b85546) Merge pull request #20 from cogine-ai/cliq/single-instance-refresh-backoff by @lc708
- [c97f388](https://github.com/cogine-ai/OpenUsageCN/commit/c97f38867a1b93fcd3c0596f4f8e51ca4e006701) Fix provider config data loss after degraded load by @cursoragent
- [0824891](https://github.com/cogine-ai/OpenUsageCN/commit/08248913564f1cc9ff5c8f0acddb6d5139380f71) Emit probe error result when plugin panics by @cursoragent
- [e540e13](https://github.com/cogine-ai/OpenUsageCN/commit/e540e13f37b621f9333157298a7e43024a453eee) test: cover local HTTP API security edges and refresh failure paths by @cursoragent
- [3fec279](https://github.com/cogine-ai/OpenUsageCN/commit/3fec27989821a769f318bcd9f85bfa4e99ee3e46) test(provider-config): serialize degraded-load tests by @lc708
- [a580c81](https://github.com/cogine-ai/OpenUsageCN/commit/a580c81c2b9d21eaa8184d2bb71efc4334105362) Merge pull request #27 from cogine-ai/cursor/critical-bug-investigation-4062 by @app/cursor
- [9a2b2e6](https://github.com/cogine-ai/OpenUsageCN/commit/9a2b2e63ae8924c34f13027e3394e1aaacae1cf1) test(local-http-api): fix query-string coverage by @lc708
- [b8ad57b](https://github.com/cogine-ai/OpenUsageCN/commit/b8ad57bdc044d3b38d7c2012b6ef81cf4373d302) test(local-http-api): tighten trailing slash coverage by @lc708
- [34e5b40](https://github.com/cogine-ai/OpenUsageCN/commit/34e5b407a845263a931ba93f65e39a065c0235b0) Merge pull request #28 from cogine-ai/cursor/missing-test-coverage-87c7 by @app/cursor
- [6e5069a](https://github.com/cogine-ai/OpenUsageCN/commit/6e5069a64a9fac78625a2c241e8914c6040784de) test: cover provider config UI and probe error state handling by @cursoragent
- [956fb9d](https://github.com/cogine-ai/OpenUsageCN/commit/956fb9d6592344dc9eeb7ec2173eb168e528386d) test: cover plugin config validation and secret view masking by @cursoragent
- [4e98ace](https://github.com/cogine-ai/OpenUsageCN/commit/4e98ace3911d5ae95cbb315e35d782a8afe55fc7) fix: label provider config toggles by @lc708
- [f45ab55](https://github.com/cogine-ai/OpenUsageCN/commit/f45ab5575b7bdb9281f24ded28e69ce656f61e0a) fix: avoid duplicated short secret hint by @lc708
- [265fc5d](https://github.com/cogine-ai/OpenUsageCN/commit/265fc5d5dfb761941e080e94aee363dfb55f0c22) Merge pull request #33 from cogine-ai/cursor/missing-test-coverage-d84f by @app/cursor
- [dbb3349](https://github.com/cogine-ai/OpenUsageCN/commit/dbb3349152357c0cb8f319bd6f5daedb5b395c6a) fix: block provider config save when disk config is unrecoverable by @cursoragent
- [6a5274b](https://github.com/cogine-ai/OpenUsageCN/commit/6a5274b6b542f9f6fc9fdedae61c35137e329e7d) docs: clarify provider config recovery saves by @lc708
- [2c943aa](https://github.com/cogine-ai/OpenUsageCN/commit/2c943aa3414f5ebc708fce96559b3e512bc6e64b) Merge pull request #44 from cogine-ai/cursor/critical-bug-investigation-dbd3 by @app/cursor
- [e854933](https://github.com/cogine-ai/OpenUsageCN/commit/e8549337cf0814e8d80f5fba627701999f09e7fd) Add CodexBar gap provider plugins by @lc708
- [8b8b491](https://github.com/cogine-ai/OpenUsageCN/commit/8b8b491c0e05bc5adfba5eda35c24f0fbbb8aee3) Address PR review findings by @lc708
- [56b725b](https://github.com/cogine-ai/OpenUsageCN/commit/56b725bdb07ffa2c4d85660a879f61106cba9034) Merge pull request #58 from cogine-ai/cliq/codexbar-provider-gap by @lc708

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
