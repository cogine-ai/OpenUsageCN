# 上游后端改进对照

日期：2026-11-02。以下为实施前的分析和建议；第一批四项随后按用户授权在本地实施，验收范围见文末。
本地基线：`2a98480` / OpenUsageCN 0.6.44。
上游基线：CodexBar `897bff31731bb4b21b105f6e8bf4c32a8a8bf095`，正式版 v0.83.0；OpenUsage `c5a2f410280ef2be7931929f0c5c03a0a2a5726f`，正式版 v0.7.16。OpenUsage main 的新认证架构尚未正式发布。

## 判断

先修认证与数据正确性，再扩展统计。上游 Swift 代码提供协议和测试案例，不直接移植语言框架。
涉及可见指标、连接方式、错误操作入口、图表或菜单栏选择的变化，先完成设计，再修改前端。
下列“可实施”表示机制与落点已清楚，不表示真实账号验收已经通过。

## 1. Cursor 加密凭据：最高优先级

证据：本机 Cursor 3.27.22 的 accessToken、refreshToken 都为 `cursor-safe-storage:v1:`。
Keychain 只查询元数据，确认 service 为 `Cursor Safe Storage`、account 为 `Cursor Key`，未读取其密码。
本地 `plugins/cursor/plugin.js` 的 `readStateValue`、`discoverConnections` 直接读取值并解 JWT。
合成加密输入调用实际 discoverConnections 得到 Desktop unavailable；既有 131 项 Cursor 测试通过，未覆盖新格式。

借鉴来源：[加密适配提交](https://github.com/steipete/CodexBar/commit/f078b60708de13c79cefd413310562f09ef14a89)、[account 名缺陷 #4880](https://github.com/steipete/CodexBar/issues/4880)。

实施建议：

- 在 Rust 后端集中读取和解密 Cursor Desktop 凭据，使账号发现、额度刷新和历史读取使用同一个结果。不要把 Safe Storage 密码交给通用 JS 插件。
- 区分明文 JWT 与加密封装；仅加密封装需要 Keychain。按已证实的 service/account 候选查找；只有明确不存在时才尝试下一个候选，拒绝、锁定和损坏不能伪装成不存在。
- 采用上游经过明确格式校验的解密步骤；同时处理 accessToken 和 refreshToken。拒绝损坏密文、错误版本和不合法身份。
- 保存“原始存储值”和“解密后的凭据”两个不同概念。并发切号保护比较原始存储值；不能把解密后的 JWT 用于与数据库密文比较。
- 加密来源的 token 刷新先仅保留内存结果，除非已实现并验证同格式加密写回。不要直接复用现有明文写回函数。
- 保留完整 subject 匹配、账号绑定、凭据代次检查，以及切号后旧结果不能发布的保障。

验证：明文、新加密格式、两种已知 account 名、拒绝与锁定、损坏密文、刷新期间切号、账号发现/额度/历史一致性。真实 Keychain 验收单独记录，mock 通过不等于实机通过。
前端：解析和解密可以独立做；新增授权/恢复交互必须先设计。
文档：`docs/providers/cursor.md`、`docs/plugins/api.md`；若错误提示改变，更新 `docs/capture-logs.md`。

## 2. Keychain 请求与错误分类：可实施，但不照搬长超时

本地 `src-tauri/src/plugin_engine/host_api.rs::inject_keychain` 使用同步 `Command::output()`，未接入 HTTP/其他子进程使用的 ProbeDeadline；失败统一包装为 item not found。
浏览器 Cursor quota 将 401/403 都包装为 session expired，helper 又将多种 Cookie 异常合成 CookieReadFailed。

借鉴：[OpenUsage #1379](https://github.com/robinebers/openusage/pull/1379)、[CodexBar Cursor 权限策略](https://github.com/steipete/CodexBar/blob/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/docs/cursor.md)。

- 区分后台读取与用户主动授权；后台不反复弹窗。同一条凭据并发请求合并，拒绝后等待明确用户动作，不循环重试。
- 子进程必须有时间上限并能结束、回收。不要将上游十分钟等待直接放进本地三十秒 probe 中。
- 内部保留缺失、拒绝、锁定/不可交互、超时、解密失败、认证拒绝、服务端禁止访问等类别。日志保留类别和关联编号，不记录原始凭据或响应。
- 403 不足以证明 token 过期；依据接口返回的可靠错误信息分类，否则报告访问被拒绝。
- 不盲目改写第三方 Keychain 条目的访问控制。上游曾因直接更新条目影响原工具信任而回退实现。

验证：拒绝不重弹、同条目并发只进行一次、超时后无残留进程、后台无需交互、网络/403 不误提示重新登录。
前端：错误类别可先在后端实现；恢复按钮、授权提示和冷却状态先设计。
文档：`docs/plugins/api.md`、`docs/capture-logs.md`、`docs/providers/cursor.md`。

## 3. Cursor 新套餐额度：协议明确，显示先设计

本地 `plugins/cursor/plugin.js` 和 `src-tauri/src/provider_accounts/browser_cursor_probe.rs` 是 Desktop/CLI 与浏览器两套读取路径，都需覆盖。
当前指标契约主要为月度 total/auto/api 池与独立 Grok Bot。
上游已区分 unified 周共享额度和旧月度双池，并单独读取额外月支出。
来源：[CodexBar Cursor 文档](https://github.com/steipete/CodexBar/blob/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/docs/cursor.md)、[Cursor 官方额度说明](https://cursor.com/help/models-and-usage/usage-limits)。

- 根据服务端套餐标志和实际周期字段选择解析规则，不能只凭套餐名称或某个接口为空推断。
- unified 共享额度只输出一次；预付余额、按量支出和额度百分比是不同资源，不能相加。
- 两条认证路径用同一组 fixture 验证相同语义；保留账号验证与独立缓存。
- 明确新的稳定 resource key，不把旧月度键悄悄解释成周额度；同步检查 `plugin.json`、CLI、HTTP limits 和额度守卫。

验证：旧个人/企业、unified 个人/团队、缺失周期、未知套餐、额度耗尽、额外消费失败但基础额度可用。
前端设计：共享额度名称、周/月周期、旧双池切换、Grok Bot 去重、菜单栏主指标。
文档：`docs/providers/cursor.md`、`docs/usage-history.md`、`docs/local-http-api.md`、`docs/cli.md`。

## 4. Cursor 历史整体时间上限：可独立做后端

本地 `cursor_history/fetcher.rs` 最多 200 页，`transport.rs` 每请求 30 秒；已有取消检查与 `scheduler.rs` 跨账号并发上限 2，但没有整个抓取任务的 deadline。
上游 [OpenUsage #1501](https://github.com/robinebers/openusage/pull/1501) 提供整体预算和有界并发的参考。

- 为整个历史任务设置总预算，每页请求上限取剩余预算；排队等待也应有明确取消/超时结果。
- 先补总预算，不立即改成上游逐日四并发。逐日切分需要额外验证日界、分页和跨区间重复。
- 保留当前最新任务取代旧任务、每页账号有效性检查、完整分页后一次性保存的行为。
- 超时报告失败并保留旧完整缓存，不把抓到的一部分标为完整；不影响已成功的额度刷新。

验证：连续慢页、预算耗尽、排队取消、切号、新任务取代旧任务、残缺结果不覆盖缓存。
前端：若沿用现有失败/旧数据展示，无需新增布局；若加入部分进度或部分结果，则先设计。
文档：`docs/usage-history.md`、`docs/providers/cursor.md`。

## 5. OpenCode Go 当前凭据选择：可独立做后端

本地 `plugins/opencode-go/plugin.js` 优先 legacy auth.json；数据库查询未筛 active，仅取第一条 opencode-go key。
上游：[77914457](https://github.com/steipete/CodexBar/commit/77914457d3bfe4124122174dfdd307c2699ed5b6)、[0179d0e1](https://github.com/steipete/CodexBar/commit/0179d0e11300226f4c33130d878c243dc1dbcb4b)。

- 现代 credential 表存在时以它为准，只读取 active 凭据；优先 opencode-go，再按明确规则接受 opencode。
- 支持 key 和未过期 OAuth access，注意 expires 使用毫秒；不自行刷新或回写原工具。
- 同一 integration 存在多个 active 凭据时报告歧义，不能 LIMIT 1 随机选择。
- 仅数据库或表不存在时使用 legacy 文件。现代数据库拒绝、损坏、无当前登录不能悄悄退回旧账号。
- 支持上游实际路径规则；新增环境变量时同步宿主 env allowlist。

验证：旧文件过时但新库有效、inactive、OAuth 到期、多 active、路径覆盖、WAL 存在时只读、401/403 订阅权限区分。
前端：复用现有本机连接流程，通常不需布局修改。
文档：`docs/providers/opencode-go.md`，如新增宿主环境能力则更新 `docs/plugins/api.md`。

## 6. Ollama JSON API：明确，但需要先设计 API Key 连接

本地 `plugins/ollama/plugin.js` 用 Cookie 读取 `/settings` HTML。上游 [#1520](https://github.com/robinebers/openusage/pull/1520) 使用 Bearer API Key 请求 `/api/balance`、`/api/me`、`/api/usage?range=7d|30d&group_by=model`。

- 可以学习 JSON 字段解析、按模型聚合及服务端统计窗口；不能假设现有 Cookie 能直接调用这些接口。
- 明确新 API Key 的存储、验证与连接关系后再切换数据来源。
- 聚合值按接口单位处理；余额、历史成本、tokens 与 requests 分开，不从成本倒算额度。
- `/api/me` 的身份字段及新响应必须加入宿主日志脱敏测试。

验证：有效/无效 key、缺权限、空历史、模型分组、窗口和数值异常、身份字段不进日志。
前端设计：API Key 接入、现有 Cookie 连接的处理、余额与历史统计的分区。
文档：`docs/providers/ollama.md`、`docs/usage-history.md`、`docs/capture-logs.md`。

## 7. OpenRouter 管理 Key：清楚的扩展，不能混合账户余额与单 Key 预算

本地已有单 Key limit、BYOK 相关用量和日/周/月值。上游新增价值是管理 Key 的多 Key 聚合和 activity 历史，见 [#1523](https://github.com/robinebers/openusage/pull/1523)。

- 先读取 `/key.is_management_key`，按权限选择普通 Key 或管理 Key 路径。
- `/keys` 分页汇总需包括禁用/过期 key，避免漏掉其历史消费；有界页数到顶不等于完整结果。
- `/credits` 的 workspace 权限不足不能抹掉可读的 Key 用量，也不能当作余额为零。
- `key hash`、key 名称和 workspace 信息需要为新 `/keys` 响应补日志脱敏。
- 不能把单 Key 预算和账户余额当成同一额度，也不能把 BYOK 与平台账单无条件相加。

验证：普通/管理/workspace key、多页、禁用 key 历史、分页中途失败、403 balance、BYOK 分离。
前端设计：Key 范围、账户余额、预算和历史的命名，以及权限不足状态。
文档：`docs/providers/openrouter.md`、`docs/usage-history.md`、`docs/capture-logs.md`。

## 8. Antigravity 配额池：协议可借鉴，需先设计多周期显示

本地 `plugins/antigravity/plugin.js::modelLine` 统一使用五小时窗口；已有 Cloud Code 接入，但未读取新 `retrieveUserQuotaSummary`。
上游 [UsageClient](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Antigravity/AntigravityUsageClient.swift) 和 [UsageMapper](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Antigravity/AntigravityUsageMapper.swift) 给出了固定 bucket ID 与 Gemini/Claude 五小时、周额度的映射，并识别 Argon 独立周池。

- 以 bucket 身份和服务端窗口建模，不能继续将所有模型一律标五小时，也不能仅按显示名合并共享池。
- production 返回缺失池时，按上游已证实规则补充 daily 来源；同一 bucket 去重，不能重复累计。
- 缺 remainingFraction 不等于零；disabled Argon 不输出；项目无订阅与 token 过期分开。
- 可验证现有 OAuth token 对新接口的可用性，但目前没有真实账号证据，不能宣称无需调整 scopes 或刷新流程。

验证：仅五小时/仅周/多池、跨来源重叠、Argon 禁用、未知窗口、缺 fraction、订阅拒绝、刷新失败。
前端设计：模型与共享池关系、五小时/周额度排列、Argon 独立池。
文档：`docs/providers/antigravity.md`；若机器额度契约改变，更新 `docs/local-http-api.md`。

## 9. ChatGPT 服务端日报：机制清楚，属于独立统计能力

本地 `plugins/codex/plugin.js::queryTokenUsage/probeHistory` 与 `local_history.rs` 处理 ccusage 本地统计。
上游 [CodexHistorySource](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Codex/CodexHistorySource.swift)、[CodexUsageReports](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Codex/CodexUsageReports.swift) 通过 OAuth Bearer 和 ChatGPT-Account-Id 读取 daily-workspace 报表，按套餐选择 tokens/turns/credits 接口。

- 单独建立服务端报表读取，不覆盖或相加到本地费用估算；credits 不擅自换算美元。
- counts 与 credits 各自记录成功/失败和覆盖范围，credits 无权限不应隐藏可读的 token 数据。
- 未报告日期不是零；credit 可能有负调整，不能套用 token 的非负校验。
- 缓存绑定凭据和 workspace/account ID，切号后晚到响应不得发布；主额度刷新不等待日报。

验证：个人/Team/Enterprise、部分报表无权限、UTC 日界、缺日/重复日、负调整、429、切号、取消、敏感用户/workspace 字段脱敏。
前端设计：本地历史与服务端报告的入口、工作区范围、延迟及覆盖日期、credits/tokens/turns 单位。
文档：`docs/providers/codex.md`、`docs/usage-history.md`。

## 10. MiniMax 与 Perplexity：来源明确，不能直接换 URL

MiniMax 本地 API Key 请求 `/v1/token_plan/remains` 并输出 Session。上游 [daf94a2e](https://github.com/steipete/CodexBar/commit/daf94a2e6235b6d774f26f6fddb0f6ea2fa1fa14) 的 China web console 走 Cookie 和 `/backend/account/token_plan/remains_percent`，包含 weekly、boost 和 unlimited 状态。
可复用 parser 与 fixture；不能把浏览器接口当 API Key 接口，不能把 Unlimited 当作零用量普通额度。
先设计浏览器连接、周额度和 Unlimited 展示；验证 CN/global 凭据隔离、百分比/permille 单位、不含套餐与无限量的区别。文档：`docs/providers/minimax.md`。

Perplexity 本地 `fetchRestState/probe` 展示 API credits。上游 [79438e43](https://github.com/steipete/CodexBar/commit/79438e43598d974b6705dd45f17915209586b703) 的 `/rest/billing/credits` 是网站订阅 credits，包含个人 recurring/purchased/promo 与组织池。
可学习组织可用余额和个人池的拆分，但成员预算剩余额度不等于组织余额。不能用新订阅 credits 覆盖或累加本地 API credits。
先设计来源名称、组织范围及选池规则，再接浏览器凭据和解析。验证个人池耗尽、组织余额不足、成员 cap、到期 credits 与账号隔离。文档：`docs/providers/perplexity.md`。

## 11. Cursor 历史收费语义与周期：先定义含义再调整数值

上游 [CursorUsageEvents](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Cursor/CursorUsageEvents.swift) 按 kind/isChargeable 筛选按量扣费，并将事件数独立于 token 计数。本地 WireEvent 没有这两个收费分类字段，没有 token 的事件也不进入模型 request_count。
可增加字段解析和分类 fixture，但新“实际按量扣费”“全部事件数”需要独立定义；未知类型和缺字段不能默认为免费，且不能直接改变既有 Metered Usage 和 CSV 的含义。
设计先解释套餐内价值、标价等值、实际按量扣费三者关系。文档：`docs/providers/cursor.md`、`docs/usage-history.md`。

本地 `grokBotLine` 和 `browser_cursor_grok.rs::decode_grok_usage` 用起止时间差推周期。
上游 [CursorSandUsage](https://github.com/steipete/CodexBar/blob/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/Sources/CodexBarCore/Providers/Cursor/CursorSandUsage.swift) 对已确认付费周额度使用七天 cadence，trial 不提供循环周期。
这可改善周期中途开始时的消耗速度计算，但只应应用于明确识别的周额度，不能给未知窗口或 trial 猜七天。验证缺 start、周中 start、trial、缺 reset、显式零额度；两条后端路径保持一致。文档：`docs/providers/cursor.md`。

## 12. 不能直接认定为待同步的内容

- Codex 压缩历史：CodexBar 保存此前扫描明文得到的缓存，不代表能首次解码所有 `.jsonl.zst`。本地委托 `ccusage@20.0.20`，必须先用明文/压缩/双份/换目录 fixture 验证该依赖，才能确认本地缺陷。不要先引入第二套扫描器。涉及文件：`host_api.rs`、`plugins/codex/plugin.js`；文档：`docs/providers/codex.md`。
- Kiro API 优先：本地已经实现，不能重复列为新增。CLI-only 凭据来源是单独候选，需验证数据库 schema、账号归属和路径后再扩展。
- Cursor 实际扣费：本地明确区分 Metered Usage 与 List-Price Equivalent，未承诺是发票。上游用 kind/isChargeable 筛选按量收费；这可作为新指标，但不能直接宣称本地旧指标算错。先核对服务端样本，再设计指标与 CSV 含义。
- OpenUsage 自主登录：可学习 PKCE、轮询取消、自有凭据存储和主动授权；它改变现有账号体验，不能作为修复 Cursor 解密的前置条件，也不应因此删除本地连接或统计。
- HTTP 主动刷新、跨 SSH 汇总、Priority 面板和预算提醒涉及新行为或前端设计，不是本轮优先后端兼容修复。
- Trae CN、WorkBuddy、Claude Platform 等新 provider 目前仅是候选；没有完成各自认证、额度语义和插件字段审计，不能标记实施就绪。

## 实施顺序与共同验收

1. Cursor 加密读取和 Keychain 请求控制；OpenCode Go 有效凭据选择可以独立推进。
2. Cursor 历史整体预算；新套餐额度先确认显示与机器接口契约，再实现。
3. Ollama、OpenRouter、Antigravity 的连接/指标设计完成后扩展后端。
4. ChatGPT 服务端日报、MiniMax 新来源、Perplexity 订阅额度作为独立功能推进，不并入认证修复。

每个插件变更均审计 `src-tauri/src/plugin_engine/host_api.rs` 的请求/响应脱敏并补针对性测试。
行为文档随对应改动更新；设计留在 design/，docs/ 只记录简短使用行为。
创建 PR 前核对 README provider 列表。凡有视觉变化，先设计并提供修改前后截图。
本轮没有修改产品代码；上游机制通过源码对照确认，除前述 Cursor 合成复现外，没有执行真实账号 API 验收。

## 第一批实施记录

已在本地实现 Cursor Safe Storage 解密、Keychain 预检和有界请求、OpenCode Go 当前凭据选择、Cursor 历史六十秒总预算。
加密 Desktop 来源不写回，明文 SQLite 刷新也改为原始凭据条件事务，避免刷新途中存储升级或切号被覆盖。
新增已知加密向量、账号切换、存储格式变化、并发 Keychain、分页/队列超时等回归测试。
没有新增前端交互或修改界面。对应行为文档已更新；未发布、未替换已安装应用。
设备 Keychain 授权、真实 OAuth 刷新与服务端额度读取仍需单独实机验收，自动测试不代表这些场景已通过。

实机验收已执行：Desktop 授权被正确拒绝，CLI 真实额度诊断 HTTP 200，但完整账号刷新仍被服务端身份格式差异阻止。见 [实机证据](evidence/cursor-backend-acceptance/README.md)。没有改变钥匙串权限或现有登录凭据。

后续按用户授权修复了身份响应兼容，并触发用户确认的系统 Keychain 授权。Desktop/CLI 各两次真实账号限定额度刷新通过；凭据和条目元数据在刷新前后未改变。最新证据见 [实机验收记录](evidence/cursor-backend-acceptance/README.md)。账号仍按完整 JWT subject 隔离，未改成后缀合并。

安装后的实际界面手动刷新验收已完成：Cursor 刷新时间更新为台北时间 18:54:27，旧错误消除，原 Arc 绑定账号与登录/加密凭据均保持不变。详见实机记录的 Local Installation Acceptance。

## 发布后的后续批次

第一批已随 v0.6.45 发布。下一批先处理 Cursor：共享周额度、403 权限分类和 Grok Bot 固定周周期。
指标与显示契约先记录在 [Cursor 周额度设计](cursor-weekly-quota-followup.md)，实现与验证状态以该批次提交为准。
Ollama、OpenRouter、Antigravity 和独立日报仍是后续设计范围，不能将本批完成视为所有上游能力已同步。

2026-11-04：上述六组后续范围已按用户授权集中实施，包含 Antigravity、OpenRouter、Ollama、ChatGPT 日报、Cursor 收费分类，以及 MiniMax/Perplexity 新来源。
当前行为、验证范围和合成渲染证据见 [本批设计与实施记录](provider-backend-expansion-2026-11-04.md)；不代表所有上游新增 Provider 或真实账号验收已完成。
