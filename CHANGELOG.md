# 更新日志

## 未发布

暂无。

## v0.6.51

### Bug Fixes

- Cursor 用量页分组展示调用、扣减记录和标价估算，保留独立金额口径及不完整标记。 ([#271](https://github.com/cogine-ai/OpenUsageCN/pull/271)) by @lc708
- 账号列表统一自动跟随与固定账号单选，修复异步切换后的键盘焦点恢复。 ([#271](https://github.com/cogine-ai/OpenUsageCN/pull/271)) by @lc708
- Codex 历史统一官方统计与本机估算入口，区分未报告日期和真实零用量。 ([#271](https://github.com/cogine-ai/OpenUsageCN/pull/271)) by @lc708
- Ollama 首页精简常驻说明，管理页明确默认账号，修复连续切换时的旧提示残留。 ([#271](https://github.com/cogine-ai/OpenUsageCN/pull/271)) by @lc708

### Chores

- 补齐回归测试、使用文档、界面设计和前后截图。 ([#271](https://github.com/cogine-ai/OpenUsageCN/pull/271)) by @lc708

### 下载说明

Windows 安装包未做 Authenticode 签名，可能触发 SmartScreen 警告。企业策略或 Smart App Control 也可能阻止运行。请用同一 Release 提供的 SHA-256 校验文件核对安装包。
缺少 WebView2 Runtime 的电脑需要联网完成安装。

---

### Changelog

**Full Changelog**: [v0.6.50...v0.6.51](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.50...v0.6.51)

- [646d706](https://github.com/cogine-ai/OpenUsageCN/commit/646d7067e7733bf7324b3ec007947a9ee551b9b1) fix(ui): make usage and account relationships visible by @lc708
- [ce546b2](https://github.com/cogine-ai/OpenUsageCN/commit/ce546b259d6ba77fd18c64681e559bfb6e658feb) fix(ui): restore account focus and refresh default notices by @lc708
- [1aebe62](https://github.com/cogine-ai/OpenUsageCN/commit/1aebe62ee93cdac88540af8cdb3ebbb9bd2b96b4) fix(ollama): clear prior confirmations before default switches by @lc708
- [daaa006](https://github.com/cogine-ai/OpenUsageCN/commit/daaa0063aa2e4f76a4d8831381de3c4bea6d2a28) Merge pull request #271 by @lc708

## v0.6.50

### New Features

- 新增 Claude Platform、WorkBuddy、Trae CN、LiteLLM、SiliconFlow、Muse Code 六家服务商的独立连接和用量展示。 ([#268](https://github.com/cogine-ai/OpenUsageCN/pull/268)) by @lc708
- Cursor 新增当前用户月度额外消费；Claude 支持原币种额外消费与模型周额度；Synthetic 支持周计划额度和独立再生信息。 ([#269](https://github.com/cogine-ai/OpenUsageCN/pull/269)) by @lc708
- Kiro 支持只读 CLI 登录及独立主额度、超额和奖励池；Z.ai 展示可用重置券数量与到期时间。 ([#269](https://github.com/cogine-ai/OpenUsageCN/pull/269)) by @lc708

### Bug Fixes

- 加强账号切换、授权取消或过期和晚到结果的隔离；Kiro 续期不会覆盖已检测到的新登录，无法确认的额度不再填成零。 ([#268](https://github.com/cogine-ai/OpenUsageCN/pull/268), [#269](https://github.com/cogine-ai/OpenUsageCN/pull/269)) by @lc708
- 安装身份密钥的 Keychain 操作与 SQLite 读取使用完整超时预算；兼容旧版 SQLite，阻断参数注入，并隐藏包含异常格式的敏感响应日志。 ([#269](https://github.com/cogine-ai/OpenUsageCN/pull/269)) by @lc708
- 修复窄面板的长模型名换行和 Unicode 标签问题，保留可验证的部分用量与原有认证错误。 ([#269](https://github.com/cogine-ai/OpenUsageCN/pull/269)) by @lc708

### Chores

- 补齐回归测试、真实 QuickJS 验证、使用文档与界面前后截图，并让 CI 覆盖各 PR 目标分支。 ([#268](https://github.com/cogine-ai/OpenUsageCN/pull/268), [#269](https://github.com/cogine-ai/OpenUsageCN/pull/269)) by @lc708

### 下载说明

Windows 安装包未做 Authenticode 签名，SmartScreen 或企业策略可能提示或阻止运行；发布时提供 setup.exe 的 SHA-256 校验文件。缺少 WebView2 Runtime 的电脑需要联网完成安装。

---

### Changelog

**Full Changelog**: [v0.6.49...v0.6.50](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.49...v0.6.50)

- [674950b](https://github.com/cogine-ai/OpenUsageCN/commit/674950b06a9432853ce25187ec2ad0e9b38ca297) feat: add six isolated provider connections by @lc708
- [f0896f2](https://github.com/cogine-ai/OpenUsageCN/commit/f0896f20ab4852c72073cfa87237b7f8d22b15ff) fix: fence Muse commits across cancellation and expiry by @lc708
- [b4875fb](https://github.com/cogine-ai/OpenUsageCN/commit/b4875fb395db94abfc3ad48965661443038913b9) feat: improve existing provider usage and credential safety by @lc708
- [5db66fb](https://github.com/cogine-ai/OpenUsageCN/commit/5db66fbf499aa52576ecdc27f1d24cbc83f8155c) ci: validate stacked pull requests by @lc708
- [f84ad8b](https://github.com/cogine-ai/OpenUsageCN/commit/f84ad8b4d6c362a3ea51a7f86799fa825b801972) fix: preserve unknown provider values and Unicode labels by @lc708
- [8cf930b](https://github.com/cogine-ai/OpenUsageCN/commit/8cf930b6fc575dbcf40885f72d18924af57f40f7) Merge pull request #268 from cogine-ai/cliq/add-six-providers by @lc708
- [fc618fe](https://github.com/cogine-ai/OpenUsageCN/commit/fc618fe52b6be169bd03a8d484d54a1d102cc0e2) fix: address provider review and isolate Kiro refreshes by @lc708
- [5f5c04d](https://github.com/cogine-ai/OpenUsageCN/commit/5f5c04dc24973bb294838072728dba12f7af0923) fix: preserve verified partial provider usage by @lc708
- [9ebfeaa](https://github.com/cogine-ai/OpenUsageCN/commit/9ebfeaa5cd291d91f37b129698c1c71351e56417) fix: support older SQLite safely and redact Kiro refreshes by @lc708
- [690985a](https://github.com/cogine-ai/OpenUsageCN/commit/690985a843cf29bd40594d0863e2a1ddd46a6ae5) Merge pull request #269 from cogine-ai/cliq/improve-provider-usage by @lc708

## v0.6.49

### New Features

- 首页统一展示所有 Ollama Cloud 账号及已配置旧连接的独立用量、余额和更新时间；主账号决定菜单栏与本地 API 的默认用量。 ([#266](https://github.com/cogine-ai/OpenUsageCN/pull/266)) by @lc708

### Bug Fixes

- 全部账号自动刷新，单账号刷新、错误和报告保持隔离；原有凭据与配置不迁移、不覆盖。 ([#266](https://github.com/cogine-ai/OpenUsageCN/pull/266)) by @lc708
- 修复配置变更、晚到请求及缓存恢复中的串号风险，报告读取共用完整超时预算。 ([#266](https://github.com/cogine-ai/OpenUsageCN/pull/266)) by @lc708

### Chores

- 补齐回归测试、使用文档、界面设计和前后截图。 ([#266](https://github.com/cogine-ai/OpenUsageCN/pull/266)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.48...v0.6.49](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.48...v0.6.49)

- [2890b30](https://github.com/cogine-ai/OpenUsageCN/commit/2890b30270fff656a9db12ca622b209c0c5d3d5a) Merge pull request #266: Ollama Cloud 首页统一展示全部账号 by @lc708

## v0.6.48

### New Features

- Ollama Cloud 支持多个账号和命名 API Key，按连接分别查看额度、余额及 7/30 天模型报告；同一账号的多个 Key 可能共享额度，额度不会相加。 ([#264](https://github.com/cogine-ai/OpenUsageCN/pull/264)) by @lc708
- 浏览账号与首页／菜单栏主账号分开，需明确选择主账号；保留原有 Cookie、单 Key 和环境变量配置。 ([#264](https://github.com/cogine-ai/OpenUsageCN/pull/264)) by @lc708

### Bug Fixes

- 验证账号身份后才保存 Key；过期验证、跨用户替换、晚到结果和等待中的刷新不会覆盖旧凭据或混用账号。 ([#264](https://github.com/cogine-ai/OpenUsageCN/pull/264)) by @lc708
- 主账号切换、移除和损坏配置的缓存清理保持同步；恢复异常锁时保留待确认数据，刷新崩溃时保留仍有效的旧用量。 ([#264](https://github.com/cogine-ai/OpenUsageCN/pull/264)) by @lc708
- 自动刷新主账号时清除旧报告并取消待完成报告，其他账号不受影响；补齐具体错误提示与详情倒计时更新。 ([#264](https://github.com/cogine-ai/OpenUsageCN/pull/264)) by @lc708

### Chores

- 补齐账号隔离回归测试、使用文档、人工审查和界面前后截图。 ([#264](https://github.com/cogine-ai/OpenUsageCN/pull/264)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.47...v0.6.48](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.47...v0.6.48)

- [85b0508](https://github.com/cogine-ai/OpenUsageCN/commit/85b0508495508236d4a6138b1f7f9541edd5cd92) Merge pull request #264: Ollama Cloud 多账号与多 API Key by @lc708

## v0.6.47

### New Features

- Antigravity 分别显示 Gemini、Claude 的五小时与周额度，以及独立 Argon 周额度；缺失数据不再按零处理。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- OpenRouter 支持管理 Key 的完整用量汇总、独立 BYOK 消费和按需加载的 Activity 报告，明确账号与工作区范围。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- Ollama Cloud 新增显式 API Key 连接、JSON 额度与购买余额，以及 7/30 天模型用量报告。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- ChatGPT 新增当前登录的服务端每日 tokens、turns 和套餐支持的 charged credits 报告，与本地日志估算分开。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- Cursor Model Usage 新增明确的按量扣费分类、完整事件数和 CSV 列，保留原有消费与请求数定义。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- MiniMax 新增 China Web 周额度、Boost 和 Unlimited；Perplexity 新增网站个人与组织订阅 credits，连接来源由用户明确选择。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708

### Bug Fixes

- 主额度刷新会清空旧服务端报告并取消旧请求，避免切号后保留上个账号的数据；读取损坏凭据时不再尝试旧登录来源。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- 修复 OpenRouter 和 ChatGPT 模型明细过多时整份报告被拒的问题，保留完整总计，明确标记部分模型展示。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- 修正 MiniMax 短倒计时单位判断，保留负 credit 调整与未报告日期的含义，并补齐新增来源的日志脱敏。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708

### Chores

- 补齐服务商、报表与本地 HTTP API 文档，以及修改前后截图和回归测试。 ([#262](https://github.com/cogine-ai/OpenUsageCN/pull/262)) by @lc708
- 加强 macOS 公证票据的有界重试、独立校验和旧标签发布恢复检查。 ([#261](https://github.com/cogine-ai/OpenUsageCN/pull/261)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.46...v0.6.47](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.46...v0.6.47)

- [13cfb31](https://github.com/cogine-ai/OpenUsageCN/commit/13cfb31df8ac1c7723ddaaf7f24aefbaeaf98be2) fix(release): verify and retry macOS stapling (#261) by @lc708
- [4dc528c](https://github.com/cogine-ai/OpenUsageCN/commit/4dc528cf19eec65fb16ac6499aaaa63acfee970a) Merge pull request #262: expand provider quotas and scoped usage reports by @lc708

## v0.6.46

### New Features

- 支持 Cursor 新套餐共享周额度，保留旧套餐月度双池；CLI 和本地 HTTP API 使用独立周额度资源，避免与 Grok Bot 重复统计。 ([#257](https://github.com/cogine-ai/OpenUsageCN/pull/257)) by @lc708

### Bug Fixes

- 修正 Grok Bot 周中开通时的周期计算；明确付费额度与有效重置时间时按七天计算，试用额度不推测循环周期。 ([#257](https://github.com/cogine-ai/OpenUsageCN/pull/257)) by @lc708
- Cursor 浏览器连接区分 HTTP 401 登录失效与 HTTP 403 访问拒绝，保留完整账号隔离和原有加密凭据保护。 ([#257](https://github.com/cogine-ai/OpenUsageCN/pull/257)) by @lc708

### Chores

- 补齐 Cursor 额度资源表和错误范围说明，将实现与验收细节保留在设计文档。 ([#258](https://github.com/cogine-ai/OpenUsageCN/pull/258)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.45...v0.6.46](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.45...v0.6.46)

- [8d5b358](https://github.com/cogine-ai/OpenUsageCN/commit/8d5b358f03f80ad7b34a31e02bd48754f67bae19) feat(cursor): support confirmed shared weekly quotas (#257) by @lc708
- [1c44f95](https://github.com/cogine-ai/OpenUsageCN/commit/1c44f95aa4a02f40113b91ac8d885c60441fbd6e) docs(cursor): finish shared weekly quota review follow-up (#258) by @lc708

## v0.6.45

### Bug Fixes

- 恢复 Cursor 加密桌面凭据读取，兼容新版身份接口，保持完整账号隔离和加密凭据只读。 ([#254](https://github.com/cogine-ai/OpenUsageCN/pull/254)) by @lc708
- 为 Keychain 后台访问设置时间上限、合并并发读取，并改善授权失败提示。 ([#254](https://github.com/cogine-ai/OpenUsageCN/pull/254)) by @lc708
- OpenCode Go 优先读取当前登录；数据库不可读或路径损坏时，不再回退到旧账号。 ([#254](https://github.com/cogine-ai/OpenUsageCN/pull/254)) by @lc708
- Cursor 历史用量刷新设置 60 秒总时限，包含排队时间；失败时保留上次成功结果。 ([#254](https://github.com/cogine-ai/OpenUsageCN/pull/254)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.44...v0.6.45](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.44...v0.6.45)

- [755e0d2](https://github.com/cogine-ai/OpenUsageCN/commit/755e0d276b57b7e696002e9ff62ff668e1ea6ac0) Fix Cursor authentication and bound backend refreshes (#254) by @lc708

## v0.6.44

### Bug Fixes

- 简化连接配置、浏览器账号添加、额度阅读、错误恢复和快捷键录制；连接检查与服务商启用独立，额度保留原单条横条。 ([#245](https://github.com/cogine-ai/OpenUsageCN/pull/245)) by @lc708
- 保存凭据后等待本次真实检查结果；环境读取失败仍可编辑已保存配置，未知地区需明确选择，其他连接方式的未保存输入不会丢失。 ([#245](https://github.com/cogine-ai/OpenUsageCN/pull/245)) by @lc708
- 展示已验证的账号身份，处理候选过期与重复使用；固定账号失效后仍可恢复跟随本机，检查失败保留上次用量和成功时间。 ([#245](https://github.com/cogine-ai/OpenUsageCN/pull/245)) by @lc708
- 修复快捷键录制、保存、回滚和注销失败的状态判断，并补齐服务商日志中标识与凭据的遮盖。 ([#245](https://github.com/cogine-ai/OpenUsageCN/pull/245)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.43...v0.6.44](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.43...v0.6.44)

- [a2c16c6](https://github.com/cogine-ai/OpenUsageCN/commit/a2c16c6e23534bbff99285090a611ee6a87757b8) 简化连接、账号、额度、错误恢复和快捷键交互 (#245) by @lc708

## v0.6.43

### New Features

- 换用 Cogine 应用、安装包、托盘、侧栏和网页图标；菜单栏在没有配额百分比但有可用余额时显示余额。 ([#238](https://github.com/cogine-ai/OpenUsageCN/pull/238)) by @lc708

### Bug Fixes

- OpenRouter 使用 Key Limit 计算菜单栏百分比，保留零余额显示，并加强 `/key` 响应的日志脱敏。 ([#238](https://github.com/cogine-ai/OpenUsageCN/pull/238)) by @lc708

### Chores

- 更新相关文档、改动前后截图和回归测试。 ([#238](https://github.com/cogine-ai/OpenUsageCN/pull/238)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.42...v0.6.43](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.42...v0.6.43)

- [dacd07a](https://github.com/cogine-ai/OpenUsageCN/commit/dacd07ab1d510aa3be9b9c21e63a8695c3776bb6) Add prepared Cogine icon assets for OpenUsageCN by @lc708
- [8a434cb](https://github.com/cogine-ai/OpenUsageCN/commit/8a434cb5fcd8b4387c70dc820000e1d5927d9b18) feat: apply Cogine branding and show balances in menu bar by @lc708
- [473b48c](https://github.com/cogine-ai/OpenUsageCN/commit/473b48c0d60228c07f4e96d8c6ba953662662f97) test: document visual change and redact OpenRouter key metadata by @lc708
- [e674d6d](https://github.com/cogine-ai/OpenUsageCN/commit/e674d6df16ace5e43f1a17e08b5a486f20ef733d) fix: fail closed on unusual OpenRouter key responses by @lc708
- [38863f5](https://github.com/cogine-ai/OpenUsageCN/commit/38863f52ad0558b9426587e8c17248231dc2c896) Merge pull request #238 by @lc708

## v0.6.42

### New Features

- 新增 DeepSeek、Moonshot、Ollama Cloud、豆包和 xAI 用量插件；首次发现已保存或环境变量中的可用凭据时，自动启用对应服务商。 ([#236](https://github.com/cogine-ai/OpenUsageCN/pull/236)) by @lc708

### Bug Fixes

- shell 凭据检查失败时保留未确认服务商供下次启动重试，同时保存其他已确认服务商的结果。 ([#236](https://github.com/cogine-ai/OpenUsageCN/pull/236)) by @lc708
- 检查 Moonshot 和豆包的地区环境变量，并为启动时的 shell 检查设置五秒上限，避免误启用或无限等待。 ([#236](https://github.com/cogine-ai/OpenUsageCN/pull/236)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.41...v0.6.42](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.41...v0.6.42)

- [41db6fc](https://github.com/cogine-ai/OpenUsageCN/commit/41db6fc115f06bab153e4b116202ad060be37120) feat: add five provider plugins and startup detection by @lc708
- [65c4df0](https://github.com/cogine-ai/OpenUsageCN/commit/65c4df0f09491fc0f25b6ea43aeff628d30d9510) fix: keep startup credential checks retryable by @lc708
- [0b21085](https://github.com/cogine-ai/OpenUsageCN/commit/0b210855ed1e8f34626900c64045ab55fa90b276) fix: resolve startup provider checks independently by @lc708
- [666ad75](https://github.com/cogine-ai/OpenUsageCN/commit/666ad75fbe9d8d16f753c6e76fabcc6bb5b21cdb) Merge pull request #236 by @lc708

## v0.6.41

### New Features

- 账号管理默认折叠，支持移除账号及其应用内连接和缓存，并可重新添加本机或浏览器账号；外部应用的登录状态不受影响。 ([#231](https://github.com/cogine-ai/OpenUsageCN/pull/231)) by @lc708
- Cursor 分别展示 Cursor Models、Other Models 月额度和独立的 Grok Bot 额度；Grok Bot 获取失败时保留其他额度，其用量不计入月度总量。 ([#232](https://github.com/cogine-ai/OpenUsageCN/pull/232)) by @lc708

### Refactor

- Cursor 每个账号仅保留最新一次成功读取的模型用量，显示实际覆盖日期并支持导出当前结果的 CSV。旧账期选择和比较已移除；旧文件仍可读取最新结果，下次成功保存会替换旧归档。 ([#231](https://github.com/cogine-ai/OpenUsageCN/pull/231)) by @lc708
- 精简账号、模型和设置页面布局，将面板高度限制在可用工作区内，最高 720 逻辑像素。 ([#231](https://github.com/cogine-ai/OpenUsageCN/pull/231)) by @lc708

### Bug Fixes

- 防止已移除的账号及缓存被并发请求或旧进程重新写回；清理失败时提供错误提示和重试。 ([#231](https://github.com/cogine-ai/OpenUsageCN/pull/231)) by @lc708
- 恢复键盘操作的焦点提示，并修正账号折叠后的滚动提示更新。 ([#231](https://github.com/cogine-ai/OpenUsageCN/pull/231)) by @lc708

### Chores

- 同步账号、Cursor 额度、缓存及 CSV 文档，补充隐私与并发回归测试，并修正 Cookie Helper 测试的临时目录竞争。 ([#231](https://github.com/cogine-ai/OpenUsageCN/pull/231), [#232](https://github.com/cogine-ai/OpenUsageCN/pull/232)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.40...v0.6.41](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.40...v0.6.41)

- [841960d](https://github.com/cogine-ai/OpenUsageCN/commit/841960df847edfe874a922a906eb5765b0d81353) feat: simplify account management and Cursor usage cache by @lc708
- [e7648fe](https://github.com/cogine-ai/OpenUsageCN/commit/e7648feb29f51cb903afe8a2c42b5d392f16d1fa) docs: clarify the CSV formula prefix by @lc708
- [19a36a2](https://github.com/cogine-ai/OpenUsageCN/commit/19a36a20e70d2093f26d4ac2a64e10495a599b1e) Merge pull request #231 from cogine-ai/cliq/compact-accounts-latest-cache by @lc708
- [d978a55](https://github.com/cogine-ai/OpenUsageCN/commit/d978a554c8dc5a110c192da6f83d9ecdd9e7efce) feat(cursor): show model pools and Grok Bot allowance by @lc708
- [0417425](https://github.com/cogine-ai/OpenUsageCN/commit/041742580f201114da18d8fc587552b6554ea80d) Merge pull request #232 from cogine-ai/cliq/cursor-grokbot-quotas by @lc708

## v0.6.40

### New Features

- 新增 `openusage guard`，让脚本按 session/weekly 和剩余额度阈值检查是否可以开始工作，并明确区分额度足够、不足和未知。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- Codex 和 Claude 的本地用量历史改为在详情页按需加载，实时额度刷新不再等待本地日志统计。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- Cursor 每个账号可保留最多 12 个已记录窗口，选择历史窗口、比较相同口径的数据，并将所选记录导出为 CSV。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708

### Bug Fixes

- 修正 OpenRouter 重置型 Key 的本期额度和 BYOK 计算，以及 Z.ai/BigModel 的独立信用额度和真实重置窗口。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- OpenCode Go 改用官方账号用量接口，支持 OpenCode 2 的精确服务商凭据读取，并正确处理空凭据查询结果。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- 连接失败时保留上次成功的额度，提供清晰的恢复提示和重试；Windows Codex 增加文件凭据指引。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- 修正 OpenCode 小于 1% 的用量显示，支持 Amp 付费订阅额度，并保留真实、可验证的账期信息。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- 修复本地历史的并发加载和进程超时问题；保留 Cursor 不同未知账期，支持损坏历史备份后的重试恢复，并清理本次导出失败产生的不完整 CSV。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708
- 补齐凭据、服务商身份和错误详情的脱敏，避免敏感内容进入日志或界面。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708

### Chores

- 同步服务商、CLI 和历史用量文档，补充回归测试及窄窗口交互验证记录。 ([#216](https://github.com/cogine-ai/OpenUsageCN/pull/216)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.39...v0.6.40](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.39...v0.6.40)

- [27660da](https://github.com/cogine-ai/OpenUsageCN/commit/27660da10113716048f788c236cb143760d45d2b) docs: record product quality delivery and validation plan by @lc708
- [32d5701](https://github.com/cogine-ai/OpenUsageCN/commit/32d57015cd5e2902907e0853f7d2cad0b638832e) fix(openrouter): respect current key quota and BYOK limits by @lc708
- [4ea5520](https://github.com/cogine-ai/OpenUsageCN/commit/4ea5520ed24a15005c7d9593f82ac8d4ea118a3c) fix(opencode-go): read account quotas from official usage API by @lc708
- [3e37658](https://github.com/cogine-ai/OpenUsageCN/commit/3e37658b53fe1a328626dfd32c7bdbbb22e29dd6) fix(zhipu): parse credit quotas without fabricated usage by @lc708
- [8e64cc8](https://github.com/cogine-ai/OpenUsageCN/commit/8e64cc8d9618da6fc8ba35bea591701a2307cc23) feat(cli): check quota thresholds before starting work by @lc708
- [888690a](https://github.com/cogine-ai/OpenUsageCN/commit/888690a0aa27cbe0d4eb60e8d54033e5f26add92) fix(codex): explain required Windows file credentials by @lc708
- [cfaf14b](https://github.com/cogine-ai/OpenUsageCN/commit/cfaf14b86d46ec29d8e7cc2a26d44d6c6413bc16) fix(opencode): preserve small usage percentages by @lc708
- [fd61a9f](https://github.com/cogine-ai/OpenUsageCN/commit/fd61a9fdf3cf52a7a9eb9e5a3feec27fc614fb62) fix(ui): make provider connection failures recoverable by @lc708
- [15c6bb8](https://github.com/cogine-ai/OpenUsageCN/commit/15c6bb8d859078c2c1e32c7470725e78f157df7a) fix(host): bound history runner checks and redact provider identities by @lc708
- [15788c8](https://github.com/cogine-ai/OpenUsageCN/commit/15788c81b4a9a4b704c04a44b989cf65ed463295) fix(amp): show paid subscription quotas without invented resets by @lc708
- [bb68d12](https://github.com/cogine-ai/OpenUsageCN/commit/bb68d12890fb82e3859ebbcd6e94956f092e084b) fix(ui): recognize Amp usage format failures by @lc708
- [ee4c7cf](https://github.com/cogine-ai/OpenUsageCN/commit/ee4c7cffb0f620fbbf0398966bce3ae9b482e083) feat(cursor): retain comparable windows and export usage history by @lc708
- [4e578b2](https://github.com/cogine-ai/OpenUsageCN/commit/4e578b2b3c9f5781eb8be9ca3f1a323a2de18af1) feat(history): load local usage separately from live quota by @lc708
- [43a85e9](https://github.com/cogine-ai/OpenUsageCN/commit/43a85e9ad27a07b5a5f5f12097b309e43829ec23) docs: align quota and history behavior across app interfaces by @lc708
- [817c2fa](https://github.com/cogine-ai/OpenUsageCN/commit/817c2fa86a9dc745124e3a36b19bca7e44b700b5) fix(cursor): keep history readable in narrow windows by @lc708
- [10186f5](https://github.com/cogine-ai/OpenUsageCN/commit/10186f5af1a78cba49ecf1eaced2d95a8e303a21) fix(history): preserve local results during quota refreshes by @lc708
- [2c67cda](https://github.com/cogine-ai/OpenUsageCN/commit/2c67cda9da97237c4ee90e1dda6781fe6c24d386) test(app): flush probe results before sidebar reload by @lc708
- [f04bcc4](https://github.com/cogine-ai/OpenUsageCN/commit/f04bcc40da571e41c2eaecc54782ff0a4b2f5c58) docs: record completed quality work and verification boundaries by @lc708
- [a43428c](https://github.com/cogine-ai/OpenUsageCN/commit/a43428cf6f19b8ae1e2a2faf724462c4fa59b06c) test(rust): isolate relative writes from directory changes by @lc708
- [eeb331d](https://github.com/cogine-ai/OpenUsageCN/commit/eeb331d7cc3951e64bf7c18441764d5d5909ef7e) style(rust): sort the local history module declaration by @lc708
- [4f52199](https://github.com/cogine-ai/OpenUsageCN/commit/4f521990b998a5abf45ec2088b0ae2e442db5695) docs: attach before and after screenshots for quality review by @lc708
- [a7e9d67](https://github.com/cogine-ai/OpenUsageCN/commit/a7e9d6799035be261be8cf262f63bbe618b1d846) fix(opencode-go): recognize empty credential query results by @lc708
- [238c7c4](https://github.com/cogine-ai/OpenUsageCN/commit/238c7c4b1abd730611f442e7bdb953ffb17ebdda) fix(history): bound pipe collection after runner exit by @lc708
- [ac0f0ad](https://github.com/cogine-ai/OpenUsageCN/commit/ac0f0adcbacd82d75867ecb92d0f3c1cf4b130c9) fix(cursor): trust only reported billing cycle dates by @lc708
- [9e57e4e](https://github.com/cogine-ai/OpenUsageCN/commit/9e57e4e20b5669da2c71ea5c0f8adfe6f0578f1d) fix(privacy): redact OpenRouter key creator identities by @lc708
- [d944bdd](https://github.com/cogine-ai/OpenUsageCN/commit/d944bdd08f28517316fc575268387dab268b507a) docs: record shipping review fixes and fresh verification by @lc708
- [c929395](https://github.com/cogine-ai/OpenUsageCN/commit/c9293958c119b2c5da58b4360c3b45023564f292) fix(cursor): retain distinct unknown billing windows by @lc708
- [feb1806](https://github.com/cogine-ai/OpenUsageCN/commit/feb18063b2b985eb59cdcdbf9927d3dd0db11ff3) fix(cursor): remove incomplete CSV exports by @lc708
- [a5d4edd](https://github.com/cogine-ai/OpenUsageCN/commit/a5d4edd1fc60547f4fc6429157e9c9b93b72ca8c) fix(history): redact errors before returning them to the UI by @lc708
- [8e58f94](https://github.com/cogine-ai/OpenUsageCN/commit/8e58f940162f4bea08c53261d2650e58f1b70b6f) fix(history): ignore uncommitted scope renders by @lc708
- [edc862e](https://github.com/cogine-ai/OpenUsageCN/commit/edc862e9b1de5fc6fb82a2f33c009866ae8ff5d6) fix(privacy): redact decoded credentials and nested Amp text by @lc708
- [f2f9c73](https://github.com/cogine-ai/OpenUsageCN/commit/f2f9c73517f13e56d8087ec5a18f76259d2c6ce5) fix(cursor): preserve damaged history and allow retry by @lc708
- [23e0c9a](https://github.com/cogine-ai/OpenUsageCN/commit/23e0c9a2ac06f97023e7478d81353c05a9401b63) docs: record PR review resolutions and final validation by @lc708
- [fcd1d5b](https://github.com/cogine-ai/OpenUsageCN/commit/fcd1d5bf6316b2e63be06a5105919575c1d6d60a) Merge pull request #216 from cogine-ai/cliq/product-quality-20260907 by @lc708

## v0.6.39

### New Features

- Add provider-first account management with stable selection and account-scoped cache projection for Cursor Desktop, Cursor CLI, and explicitly selected Chrome and Arc profiles ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708
- Add current billing-cycle Cursor model-token history grouped by local day and model, including input, output, cache-read, cache-write, and request totals ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708
- Add verified Claude Team seat enrichment and account-capability declarations for supported provider plugins ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708

### Bug Fixes

- Harden provider-account refresh ordering, snapshot recovery, credential races, browser-session isolation, identity redaction, Keychain installation-key handling, and timezone-aware history windows ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708
- Apply the configured app proxy consistently to browser-account validation, Claude enrichment, Cursor history, and provider HTTP requests ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708

### Chores

- Upgrade ccusage to `20.0.20` and recognize Cursor Pro+, Codex Pro 5x, and Claude Team plan labels ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708
- Add dual-architecture macOS Cookie Helper packaging checks, signed/notarized package verification, updater validation, and release documentation ([#205](https://github.com/cogine-ai/OpenUsageCN/pull/205)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.38...v0.6.39](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.38...v0.6.39)

- [ff83dfb](https://github.com/cogine-ai/OpenUsageCN/commit/ff83dfb7c0b5fb2e08ce75f3ea882d265f8eee5e) docs: design provider accounts and cursor history by @lc708
- [6265b08](https://github.com/cogine-ai/OpenUsageCN/commit/6265b08f40a5303ba48a84e934cfcff88aba8eb3) chore: update provider plans and ccusage by @lc708
- [2c36c4f](https://github.com/cogine-ai/OpenUsageCN/commit/2c36c4fda9c1f0c4df33bd4419c1361c9a8d9da3) feat: declare plugin account capabilities by @lc708
- [8619f08](https://github.com/cogine-ai/OpenUsageCN/commit/8619f0850e671a805e883719686e92fef379e135) feat: add provider accounts and cursor history by @lc708
- [0a82067](https://github.com/cogine-ai/OpenUsageCN/commit/0a820672eef76918eb0505a5f4e52a6d5582e4a9) docs: document account-aware provider usage by @lc708
- [16ea28a](https://github.com/cogine-ai/OpenUsageCN/commit/16ea28a72b25a07e1aec0fc53eb359699069ed0f) fix: harden provider account refresh and release checks by @lc708
- [fd0ca30](https://github.com/cogine-ai/OpenUsageCN/commit/fd0ca3019a22638c17d285c978e688f4d8f4e067) fix: honor app proxy for account requests by @lc708
- [d096925](https://github.com/cogine-ai/OpenUsageCN/commit/d096925b9f9662386cbd11be448f43d4d68c9fd5) fix: harden provider account boundaries by @lc708
- [d0bfb13](https://github.com/cogine-ai/OpenUsageCN/commit/d0bfb1348fb25f6bb5e850216aebdc99ca7a7fbc) Merge pull request #205 from cogine-ai/cliq/provider-accounts-cursor-history by @lc708

## v0.6.38

### Bug Fixes

- Reject invalid or ambiguous OpenRouter API base URLs before sending API credentials, while preserving valid custom HTTPS hosts, ports, and base paths ([#162](https://github.com/cogine-ai/OpenUsageCN/pull/162)) by @lc708
- Ensure overlapping provider refreshes publish only the latest usage result and preserve correct loading and manual-refresh state when batch starts fail ([#162](https://github.com/cogine-ai/OpenUsageCN/pull/162)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.37...v0.6.38](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.37...v0.6.38)

- [67b6330](https://github.com/cogine-ai/OpenUsageCN/commit/67b63300a1ac8ef13496750fa679ee7422fd8b46) fix: harden OpenRouter URLs and probe ordering by @lc708
- [5a4519e](https://github.com/cogine-ai/OpenUsageCN/commit/5a4519e38eeda2801389feaac4114d6700234787) Merge pull request #162 from cogine-ai/cliq/openrouter-latest-probes by @lc708

## v0.6.37

### Bug Fixes

- Restore `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` inheritance for provider and provider-status requests by @lc708

---

### Changelog

**Full Changelog**: [v0.6.36...v0.6.37](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.36...v0.6.37)

- [c204e86](https://github.com/cogine-ai/OpenUsageCN/commit/c204e8602f333f9ccd07fff3382e8185dc123ef3) fix: restore environment proxy inheritance by @lc708

## v0.6.36

### New Features

- Add the Windows MVP with tray panel behavior, platform-aware capabilities, autostart, Codex usage collection, local HTTP API support, and Windows x64 NSIS publishing ([#127](https://github.com/cogine-ai/OpenUsageCN/pull/127)) by @lc708

### Bug Fixes

- Repair Windows credential replacement and preserve rotated Codex refresh tokens during guarded concurrent auth updates ([#127](https://github.com/cogine-ai/OpenUsageCN/pull/127)) by @lc708

### Chores

- Add Feishu merge notifications and link notifications to the relevant commit pages ([#112](https://github.com/cogine-ai/OpenUsageCN/pull/112)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.35...v0.6.36](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.35...v0.6.36)

- [7e0e23b](https://github.com/cogine-ai/OpenUsageCN/commit/7e0e23b6ebffe21d52ec6f689642bf3286190ff0) Merge pull request #127 from cogine-ai/cliq/windows-mvp by @lc708
- [3fdb7a4](https://github.com/cogine-ai/OpenUsageCN/commit/3fdb7a4a8b41b31770c0c68032e4d95921951bae) fix: preserve rotated Codex tokens by @lc708
- [fb3ecd0](https://github.com/cogine-ai/OpenUsageCN/commit/fb3ecd06cc9cc807185f2284a9634c0868d61bb6) fix: repair Windows credential replacement by @lc708
- [0d9ced2](https://github.com/cogine-ai/OpenUsageCN/commit/0d9ced2b5f4975cd318add56040ed90f5e2bb2ab) Update application functionality and supporting tests by @lc708
- [c79e7b9](https://github.com/cogine-ai/OpenUsageCN/commit/c79e7b9dbec3914b51f48f00f23a7d9e6eb7f80c) Merge pull request #112 from cogine-ai/cliq/add-feishu-notifications by @lc708
- [b8a1850](https://github.com/cogine-ai/OpenUsageCN/commit/b8a185069e2cac73d19de7ff691c60e3d2158cd8) fix(ci): link Feishu pushes to commit pages by @lc708
- [68de827](https://github.com/cogine-ai/OpenUsageCN/commit/68de827a702fc8c4e49f625f15bcff4f96c10238) ci: add Feishu notifications workflow by @lc708

## v0.6.35

### New Features

- Add the machine-readable `/v1/limits` contract, global `openusage` CLI, reset-boundary refresh, provider incident notices, and quota pace notifications ([#101](https://github.com/cogine-ai/OpenUsageCN/pull/101)) by @lc708

### Bug Fixes

- Harden installed CLI plugin loading, preserve valid resources after projection errors, stabilize reset-boundary notifications and refresh retries, and reject invalid cache timestamps ([#101](https://github.com/cogine-ai/OpenUsageCN/pull/101)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.34...v0.6.35](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.34...v0.6.35)

- [d748157](https://github.com/cogine-ai/OpenUsageCN/commit/d74815714caa70c0296eab9a28b1f2ed9e645dba) feat: add machine-readable limits and quota alerts by @lc708
- [8023dab](https://github.com/cogine-ai/OpenUsageCN/commit/8023dabb58f0aea0978f51622eab39d7e8393eb9) fix: address quota review findings by @lc708
- [eca9ad3](https://github.com/cogine-ai/OpenUsageCN/commit/eca9ad3bc40bf267db42190ca05b55d2ea9c52b7) Merge pull request #101 from cogine-ai/cliq/limits-cli-pace-notifications by @lc708

## v0.6.34

### Bug Fixes

- Fall back to the weekly Codex metric when the default primary window is temporarily absent, keeping the menubar percentage visible ([#96](https://github.com/cogine-ai/OpenUsageCN/pull/96)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.33...v0.6.34](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.33...v0.6.34)

- [677b05b](https://github.com/cogine-ai/OpenUsageCN/commit/677b05b0038718b21fd802ed61a51b116d4774f7) Merge pull request #96 from cogine-ai/cliq/fix-menubar-weekly-fallback by @lc708
- [cffed78](https://github.com/cogine-ai/OpenUsageCN/commit/cffed7836b3b4f3b2c1361be1374c1b08bf2abb9) fix(menubar): fall back to weekly metric by @lc708

## v0.6.33

### Bug Fixes

- Classify Codex rate-limit windows by duration so weekly-only and reversed responses display the correct labels and ordering ([#93](https://github.com/cogine-ai/OpenUsageCN/pull/93)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.32...v0.6.33](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.32...v0.6.33)

- [1490ae7](https://github.com/cogine-ai/OpenUsageCN/commit/1490ae7f4a65321c39d091a83a479c21abcbd120) Merge pull request #93 from cogine-ai/cliq/codex-weekly-window-normalization by @lc708
- [d7f6ca1](https://github.com/cogine-ai/OpenUsageCN/commit/d7f6ca1bc85f380a96690386b795c803d95c0ee6) fix(codex): classify rate windows by duration by @lc708

## v0.6.32

### New Features

- Localize Codex usage metrics, add Chinese token units, and show the next manual-reset expiry with a warning color ([#89](https://github.com/cogine-ai/OpenUsageCN/pull/89)) by @lc708

---

### Changelog

**Full Changelog**: [v0.6.31...v0.6.32](https://github.com/cogine-ai/OpenUsageCN/compare/v0.6.31...v0.6.32)

- [0648527](https://github.com/cogine-ai/OpenUsageCN/commit/064852769c1ea80c1ec9291af1891da2657596fe) Merge pull request #89 from cogine-ai/cliq/codex-manual-reset-expiry-cn by @lc708
- [fd8a101](https://github.com/cogine-ai/OpenUsageCN/commit/fd8a1016ce951fcf6dd6794cf06db7775e2150d6) feat(codex): localize usage and show reset expiry by @lc708

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
