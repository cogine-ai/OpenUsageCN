# Provider Usage Expansion

日期：2026-11-04。基线：`13cfb31`，已发布 v0.6.46。用户授权按优先级在一个 PR 内完成以下六组功能；本文件先定义行为与界面，再实施。

## 使用场景与界面方向

用户打开菜单栏应用，先判断剩余额度，再进入服务商详情核对来源、周期与消费。
沿用现有紧凑卡片、进度条、详情文字和历史图表；不增加总览仪表盘或改变导航。
领域词汇是账号、工作区、额度池、重置周期、实际扣费、服务端报告。
颜色沿用背景、卡片、边框、正文、弱化文字和现有错误色，服务商颜色只用于其现有识别。
这批的识别重点是“同一账号内仍明确区分来源和周期”。不把所有数值合成总额度，不把未知数据画成零，不把权限失败藏成空结果。

连接方式变化使用现有连接设置中的字段。标题使用 Title Case；普通说明保持简短。
托盘保留旧指标优先级；旧指标不存在时，Antigravity 可选新的 Gemini/周池，OpenRouter 可选管理 Key 的账户 Credits，Perplexity 可选网站订阅池。
Antigravity 的周额度偏好采用 Gemini Weekly；只返回 Claude/Argon 的账号仍能使用其有效池作为普通主指标。
主额度保持现有刷新入口。较慢的历史报告按需加载，在详情中独立显示 **Server Reports**，不阻塞主额度。
报告提供 Loading、Empty、Unavailable、Error 状态；已有可读报表在另一报表无权限时仍可显示，并明确范围与缺口。
金额、credits、tokens、turns 和 requests 使用各自单位；缺失日期与已报告零值分别处理。
截图使用合成账号和生产组件，修改前后保持相同视口；截图不等于真实账号验收。

## 六组功能与验收

| 顺序 | 功能 | 连接与数据含义 | 展示 |
| --- | --- | --- | --- |
| 1 | Antigravity | 按 bucket 身份读取 Gemini/Claude 五小时和周池；Argon 独立周池。相同凭据下 production 优先，daily 仅补缺。缺 fraction 不等于零。 | 沿用进度条，五小时与 Weekly 分列；未知周期不猜五小时。 |
| 2 | OpenRouter | 自动识别现有 API Key 是否为管理 Key；完整分页读取包括 disabled/expired 的 Key。账户余额、Key 预算、平台消费与 BYOK 分开。 | 现卡片保留普通 Key 行为；管理范围、Key 汇总和 BYOK 分列；Activity 放独立报告区。 |
| 3 | Ollama | 新 API Key 来源与现有 Cookie 来源显式选择，不在拒绝后切换账号。JSON balance/me 与 7/30 天模型用量遵循接口单位。 | 沿用连接配置；余额和额度分开。7/30 天统计放报告区，标明窗口与模型。 |
| 4 | ChatGPT | 当前本地 ChatGPT 登录的服务端日报，按套餐读取 tokens/turns/credits。与本地 ccusage 独立；credits 不换算美元。 | Codex 详情新增 Server Reports，与 Local History 分开。显示账号/工作区范围和各报表可用性。 |
| 5 | Cursor | 在原始事件中读取 kind/isChargeable，增加明确的按量扣费分类与全部有效事件数。旧 Metered Usage、List-Price Equivalent 不改含义。 | Model Usage 增加 On-Demand Charges 与 Usage Events；金额未知显示不可用/不完整。CSV 只追加明确命名的新列。 |
| 6 | MiniMax 与 Perplexity | MiniMax API Key 与 CN 网页 Cookie 显式分源，支持网页 weekly/boost/unlimited；Perplexity API credits 与个人/组织订阅 credits 分源，成员上限不等于组织余额。 | 使用现有连接字段与指标组件；Unlimited 使用文字/徽标，不伪造零额度。个人池与组织池保持名称和范围。 |

### OpenRouter 范围

`/keys` 的默认组织管理范围与 `/activity` 的默认范围不同。Key 列表的汇总命名为 Listed Keys Spend；Activity 独立标明账号或工作区范围，不覆盖列表汇总。
工作区参数只来自已验证的服务端 Key 元数据；不能从显示名称猜测。
多页未完成、重复页或超出上限不能输出“完整总计”。余额权限不足保留已有 Key 用量，并显示余额不可用。

### ChatGPT 账号与取消

本批不增加 Codex 多账号管理。读取当前本地凭据，绑定完整用户身份、ChatGPT account/workspace 与原始凭据代次。
服务端报告独立于本地估算；切号、凭据变化或新请求取代旧请求后，旧结果不能发布。
请求、分页与重试共享有界总预算；主额度不等待报告。没有日期不能补零；负 credit 调整不能按 token 非负规则丢弃。

### Cursor 收费含义

Metered Usage 仍为当前窗口有效事件的 `chargedCents` 汇总，List-Price Equivalent 仍为已知模型标价。
On-Demand Charges 只汇总明确属于按量收费的事件；未知 kind 或缺少收费标志不能默认为免费。
Usage Events 统计窗口内有效时间戳的事件，包括没有 tokens 的事件；Requests 保持原有有 tokens 的请求定义。
记录覆盖状态，旧缓存缺少新字段时显示未知，刷新后补齐；不得把旧缓存解释成零实际扣费。

## 实现与研究边界

协议来源：既有 [上游评估](upstream-backend-review-2026-11-02.md) 固定的 CodexBar `897bff3`、OpenUsage `c5a2f41`，并核对实施时官方 API 文档。
上游源码是协议参考，不能直接搬入其账号、缓存或 UI 框架。
QuickJS 不支持 Node 模块。为保持单文件长度，插件可在 manifest 声明有序 `supportingScripts`，宿主只读取同一插件目录内的显式文件，先执行辅助脚本再执行入口；不提供动态 require 或额外文件访问权限。
按需报告使用单独入口 `probeReports(ctx)`，不混入主额度和本地历史。
返回 `{scopeKey, lines, reports}`；Rust 加上 `providerId` 与 `fetchedAt`。
`scopeKey` 为来源、完整账号/工作区、凭据代次的 SHA-256，不向前端传递原始 ID 或凭据。
`lines` 仅复用 text/barChart；`reports` 各自包含 id、label、status，可带 message、retryAt 与 coverage。
status 区分 ready、partial、notSupported、permissionDenied、rateLimited、authExpired、error。
coverage 使用 fromDate/toDate/timeZone，并列出 reportedDates/missingDates，不将未报告日期补零。
UI 按需调用 `refresh_provider_reports`，逐个显示可用性和覆盖范围；同服务商新请求取代旧请求，组件卸载与连接配置变更使旧响应失效。
Codex 固定当前来源，前后重读完整原始凭据并验证用户/工作区；日报不自行刷新或写回 rotating token。
过期或 401 引导使用现有额度刷新后重试，避免并发写入。

新增来源选择：Ollama 为 Cookie（原默认）或 API Key；MiniMax 为 API Key（原默认）或 China Web；Perplexity 为 Desktop API（原默认）或 Web Subscription。
切换来源由用户明确操作；错误后不跨来源切换。Secret 沿用应用现有 `providers.json` 配置保存机制，界面遮蔽显示；该配置文件不是 Keychain，文档需如实说明。
Ollama 报告分别给出 7/30 天，独立记录覆盖状态；OpenRouter Activity 为最近 30 个已结束 UTC 日。
新增插件请求/响应、Key 名称/hash、用户、组织与工作区字段统一审计宿主脱敏。
不读取真实 Key、Cookie 或外部工具密码做合成测试，不写回第三方凭据。

## 文档与验证计划

行为文档：`docs/providers/antigravity.md`、`docs/providers/openrouter.md`、`docs/providers/ollama.md`、`docs/providers/codex.md`、`docs/providers/cursor.md`、`docs/providers/minimax.md`、`docs/providers/perplexity.md`、`docs/usage-history.md`、`docs/plugins/api.md`、`docs/plugins/schema.md`、`docs/local-http-api.md`、`docs/capture-logs.md`；核对更新 `README.md` 支持能力。
设计与合成截图说明仅放 `design/`。

测试复用现有插件 probe、历史 IPC、Cursor 完整快照/CSV 和生产组件测试边界。
覆盖认证拒绝、403、部分权限、损坏响应、空数据、分页终止/失败、重复数据、周期/日界、切号与晚到响应、取消/总预算、单位、负调整和脱敏。
新模块在 QuickJS 中实际加载执行，不能仅以 Node import 通过作为运行时兼容证据。
最终执行插件 bundling、相关与全量 JS 测试、前端 build、Rust 测试和适当平台检查。
涉及视觉变化必须提供 Before/After 截图及加载、空、部分失败状态验证，再创建单一 PR。

## 状态

六组功能已实施，并完成定向回归、跨组只读复核及修复。报告使用精确 requestId 取消，宿主前后检查真实配置摘要；Codex 仅允许首个明确存在的来源，不在读取失败后切换到旧账号。
MiniMax 的秒/毫秒、Boost 与旧模型别名已按上游样本修正。新指标补齐托盘主候选和现有周额度偏好。
新增 `tempfile` 的全平台测试依赖复用已有锁定版本，支持安全路径和旧缓存回归；不增加运行时依赖或升级版本。
当前全量 JS 2,142 项与前端构建通过，完整串行 Rust 628 项通过、3 项设备验收忽略；其中包含 6 项主额度/错误传递与 6 项报表真实 QuickJS 测试。
一次并发 Rust 验证中，两项既有子进程启动 fixture 未在时间窗内启动；独立重跑和完整串行验证均通过。未调整其超时门槛。
最终只读需求审查无未覆盖项；规范复核发现的主额度 Error 对象丢失具体提示已修复，并补先失败、后通过的真实 VM 回归。CI 结果以 [PR #262](https://github.com/cogine-ai/OpenUsageCN/pull/262) 为准。
Windows CI 首次暴露了报表合成 fixture 仅提供 Mac 默认路径的问题；测试现显式覆盖 Windows/Mac 两条真实默认路径及读取失败，未更改产品凭据优先级。
修改前后截图与状态检查见 [渲染证据](evidence/provider-backend-expansion/README.md)。所有协议输入与账号为合成数据；真实服务账号、原生安装和账单对照尚未验收。
