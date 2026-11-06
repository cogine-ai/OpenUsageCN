# Existing Provider Improvements

日期：2026-11-06。状态：设计供审阅；未修改产品代码，不属于新增六家 Provider 的第一批 PR。

## Direction

用户在写代码的间隙打开 400×500 菜单栏面板，想判断哪个额度先限制工作，以及额外消费、可再生额度、重置券分别是什么。方向沿用既有 ProviderCard / QuotaMetric / MetricLineRenderer，不新增导航、设置体系或 metric schema。

- 领域词：套餐额度、额外消费、个人范围、原币种、小数位、模型周额度、再生、超额、奖励、重置券、到期。
- 颜色：系统深色背景、浅色背景、次级表面、弱文字、边框，以及既有成功/警告/错误语义；金额不靠品牌色表达币种。
- 核心识别：先读主额度，再读独立的额外池；每条金额/时间明确单位与含义。Cursor 月度额外消费、Claude 原币种、Synthetic 再生、Kiro 超额、Z.ai 券到期均分别命名。
- 避免默认：不把所有池加成“总额度”，不把任何时间都做重置倒计时，不将所有钱都画为美元进度。
- 视觉约束：系统字体；Provider 标题 16px/600、进度标题 14px/500、辅助 12px；16px 面板内边距、4px 空间基线、现有轻边框。320px 窄窗纵向滚动。深浅色沿用语义 token；图标只用现有 lucide。
- 焦点层级：现有主额度 progress 为第一层，独立额外池为第二层，范围/再生/到期等 text 为第三层。已有连接恢复入口仍在原位。

## Current Code Evidence

已核对 `plugins/{cursor,claude,synthetic,kiro,zai}/plugin.{json,js}` 和对应 provider 文档。

- Cursor 已有 detail `On-demand` 与稳定 `onDemand` resource，目前仅读取 `spendLimitUsage`；模型历史页中的 `chargedCents` 是另一用途。
- Claude 当前只固定 Sonnet / Claude Design，并将 Extra Usage 当美分美元；`ProgressFormat` 只提供 percent / dollars / count，dollars 渲染固定 `$`。
- Synthetic 当前同时支持 Rolling 5h、Mana Bar 与旧 Subscription；已有 nextRegenAt 但没有正确展示新 planWeeklyLimit。
- Kiro 当前只有 Credits / Bonus Credits progress 与 Overages 开关 badge，缺少独立超额计数。
- Z.ai 当前只有 Session / Weekly / Web Searches；没有券列表，不能把未取得列表显示成零张。
- ProviderCard overview 按 manifest 的静态 label 过滤；详情显示全部运行时 metric。动态模型名适合先在详情分列，无需增加动态 scope/schema。Fable 可使用已确认的 `fable` resource；其他未知模型先仅在动态详情展示，不创建猜测资源键。

## Cursor

详情沿用主额度与账号选择。统一计划仍先显示 Shared Weekly Usage；新增按当前选中账号、当前用户取得的月度 On-Demand progress，例如 `USD 12 / USD 50`。底层保持既有 `onDemand` resource；不可与历史页 Metered Usage / chargedCents 累加，也不推断为团队所有成员的账单。

- 有有效 usedCents/limitCents：按美分换算，只显示该用户范围；来源 caption 用 `Current User`，不展示邮箱/userId。
- 仅有消费或没有正额度上限：使用原有 text 行，不制造无限或零上限 progress。
- 月度重置只有真实账期边界才进入 resetsAt；统一套餐的 weekly reset 不借给月度额外消费。
- 旧 spendLimitUsage 路径保留原有意义；未取得新数据不跨账号回填另一连接的消费。
- 首页和菜单栏主额度策略保持；On-Demand 仍是详情信息，不在首页重复计算。

## Claude

Session / Weekly 仍在首页。任意 weekly_scoped 模型以独立 percent progress 出现在详情，例如 `Fable Weekly`，同时展示其他模型如 `Sonnet Weekly`。只使用该项提供的 utilization / reset；未知模型名作为受限纯文本标签，不执行、不当作 HTML，也不归并入 Sonnet。过长名称换行；缺失或坏数据只影响该项。同一模型若同时有旧字段和 weekly_scoped，只保留已验证的新项，不重复展示或相加。

Extra Usage 先按 `decimal_places` 把数值金额换成原币种金额，不固定除以 100。原币种 code 必须可见，保留有效零值。

- 已确认 USD：可沿用现有 dollars progress，按实际小数位换算，保留现有 `extraUsage` 的 USD resource 意义；非 USD 不导出美元资源。
- 非 USD：使用两条现有 text：`Extra Spent · JPY 500`、`Extra Limit · JPY 1,000`。BHD 例子为 `BHD 1.234` / `BHD 10.000`。不借 count suffix 冒充金额，不增加 currency schema。
- 没有可用正上限：只显示 Spent；不能把缺失上限解释为免费、无限或 0。
- 旧协议省略字段时沿用上游客户端的兼容默认（USD / 2 位）；显式币种、精度或金额无可靠值时：该金额项显示不可用，Session / Weekly 保留；不猜 USD 或小数位。
- 非 USD 的精确金额先作为详情文本，不新增菜单栏金额格式；原有 Session / Weekly 主指标继续可用。若未来需要原币种菜单栏预算，另行设计通用货币类型，本批不扩范围。

## Synthetic

新协议存在时，主视图使用 planWeeklyLimit 的 `Weekly` percent progress。旧 Subscription / Rolling 5h / Mana Bar 不与新协议并排，以免把已过时的窗口当成同时约束；搜索等仍然独立的已确认项目可保留。

`Next Regen` 与 `Regen Percent` 使用详情 text，例如 `2026-11-07 00:30 UTC+08:00` 与 `2%`。先仅称“再生百分比”；具体是恢复份额还是恢复后的余额，必须以后端已验证契约为准再决定是否加“增加/恢复到”。它们不填入 progress.resetsAt，也不触发“重置时剩余”预测。

仅有再生时间不代表周额度完全恢复，也不推算每次频率或完整再生日期。时间不可用时保留 Weekly，单独标明再生时间不可用。旧协议在没有新协议时继续按其真实字段显示，不重写用户配置。

## Kiro

主 Credits 与 Overage Credits 是两条独立 count progress：`Credits 100 / 100 credits`、`Overage Credits 20 / 50 credits`。主额度已满仍显示已达上限；超额池单独显示，不把主进度画成 120/100，也不合成 120/150。

Bonus Credits 若存在继续独立显示，不加到主额度或超额池。CLI 只给出包含奖励的合计时，不能仅减 overage 就称为纯套餐主额度；无法可靠拆分时主 Credits 显示 Unavailable，仍保留已确认的 overage / bonus。Overages Enabled/Disabled 作为辅助 badge，与实际超额计数不是同一信息；未知开关不猜 Disabled。奖励到期不画成套餐重新补满。

CLI 登录/过期状态沿用现有本机登录恢复入口，后端完成 CLI 识别后给出准确步骤，不新增账号表单或 token 输入。未取得超额计数不显示 0/50，只影响该池。

## Installation HMAC Keychain

这是第六组中的纯后端改进：为安装级 HMAC 密钥的 Keychain 操作限制总耗时。没有新增设置页、授权开关或 Provider 行；使用现有错误/诊断入口，固定友好说明，日志区分缺失、拒绝、锁定与总超时。不得为失败新建替代身份、覆盖已有密钥或清除账号。界面验收仅确认现有错误可见、刷新不会一直转圈。

## Z.ai

Session / Weekly / Web Searches 继续在前。详情新增只读 text：`5h Reset Coupons · 3`、`Weekly Reset Coupons · 1`、`Coupon Expiry · 2026-11-07 00:30`，subtitle 明确 `UTC+08:00`。banked5h 与 weekly 数量分别显示，不合成“额外 token/额度”。

- 已成功取得且确认没有券：明确 `0`；列表没取到或无权限：只标相应券项 `Unavailable`，保留主额度。
- 最近到期从有效未过期券中选择；没有未过期券时到期项显示 `None`，不使用伪造时间。
- 后端解析无时区时间必须依协议视为 UTC+08:00，之后再格式化为明确时区文本。例如 `2026-11-07 00:30:00` 不得先当 UTC 后再次加 8 小时。若呈现本地时区，必须标出对应时区并跨日正确。
- 到期是券失效，不是 Session / Weekly reset；不要传为 progress.resetsAt，也不使用重置切换按钮。
- 全部只读：没有使用券、重置额度、自动消耗或打开写操作的按钮；原有 API Key 配置不变。

## States And Validation

首页保持紧凑，新增细节以 detail 行承载。检查中保留同一连接上次数据与真实时间；更换账号/配置先清旧读数，失败不回填其他账号。部分字段不可用只显示该字段不可用；认证失败沿用原连接恢复入口；有效 0 与未取得明确区分。

设计原型为合成数据；展示 Ready、Partial、Zero、Expired 四种状态，400/320px 与深浅色。验证五组可见变化；HMAC 不制造新界面。金额样例覆盖 USD/JPY/BHD，日期样例覆盖 +08:00 跨日，模型名覆盖未预设的 Fable。标题使用 Title Case。辅助信息用可选中文本；进度和文字复用既有组件，不添加新的交互控件。

## Implementation And Docs Plan

本设计不改变生产文件。后续实现优先插件输出与 manifest 字段；原型中的标签最终与 manifest 保持一致，确保 overview/static label 与资源键兼容。大多数组可仅输出既有 progress/text/badge；只有动态长模型名排版若真实组件溢出，才做局部前端修复并提供前后截图。

文档计划：`README.md`、`docs/providers/cursor.md`、`docs/providers/claude.md`、`docs/providers/synthetic.md`、`docs/providers/kiro.md`、`docs/providers/zai.md`；HMAC 总超时和来源缓存行为更新 `docs/app-state-architecture.md`、`docs/cli.md`、`docs/local-http-api.md`，敏感日志范围更新 `docs/capture-logs.md`，如宿主限制发生变化同步 `docs/plugins/api.md`。五家 provider 文档加纯后端 HMAC 共六组，不虚构第六家 provider 文档。

验收要求：金额换算/币种、动态模型、旧新协议排他、再生非重置、overage/bonus 隔离、券只读与时区、部分失败、账号隔离和日志脱敏回归；产品组件前后截图在后续实现批次补齐。设计截图不代表真实 API、安装后或真实账号验收。


## Production Visual Verification

经主任务 GO 后，只补了两处必要前端适配：固定 Kiro CLI 认证错误沿用本机连接页，提供可复制的 `kiro-cli login` 而不执行；QuotaMetric 的长模型标题在 320px 换行。实际测得修复前滚动容器宽 635px，修复后为 320px。金额、额度、再生、超额与券信息全部由真实插件 probe 输出既有 metric 类型，未扩 schema。

证据位于 `design/evidence/provider-improvements/`。旧五家插件从基线 `674950b` 冻结，以内存 host 执行后给真实 ProviderDetailPage / ProviderCard；40 个 before 场景通过。新插件也执行真实 probe 生成合成输出，实际组件首轮 93 场景通过；Claude / Kiro 后续收口后，受影响部分复验 45 场景通过。另有 13 项针对 Kiro 登录截图、设计中未知主池和奖励到期的核验。收据分别保留源码 SHA256，便于对应具体版本；没有以设计原型冒充产品组件。

全部浏览器数据、凭据、账号和 IPC 均为合成；没有真实认证、Keychain 或系统剪贴板操作。实际 API 访问、安装后验收、HMAC Keychain 总超时和原生 source-scoped 缓存由主任务独立验证。
