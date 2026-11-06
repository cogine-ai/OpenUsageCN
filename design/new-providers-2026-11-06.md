# Six Provider Connections

日期：2026-11-06。基线：OpenUsageCN v0.6.49 / `02af5b2`。
用户要求先新增 Claude Platform、WorkBuddy、Trae CN、LiteLLM、SiliconFlow、Muse Code，再优化现有 Provider。本文件在产品代码修改前定义界面与行为。

## 使用场景与方向

用户在菜单栏查看还能用多少额度，进入服务商详情核对余额、周期、组织和来源，再按需要修复连接。新增六家沿用现有服务商选择、连接页和紧凑用量卡片；面板仍以 400×500 为基准，320px 窄窗内容纵向滚动。

- 领域：连接、账号、组织、虚拟 Key、余额、赠送额度、已用额度、周期、到期、授权码。
- 颜色：现有深色背景 `#1c1c1e`、正文 `#ededed`、次级表面 `#2a2a2c`、弱文字 `#888`，以及既有成功、警告、错误语义色。品牌色只识别服务商，不成为金额的含义。
- 识别特征：同一张卡片先显示影响继续工作的剩余额度，再清楚标出额度属于哪个来源/组织；到期、重置、再生分别命名，金额按原币种显示。
- 避免三种默认：不另做总览仪表盘，不把余额画成百分比，不把个人/成员/团队三个范围做可相加的总数。
- 延续系统字体与紧凑密度：标题 16px/600、正文 12–14px、辅助 11px；4px 空间基线，面板内边距 16px，相关字段间隔 16px，主按钮高 40px。前景/背景/边框复用 `src/index.css` 语义 token。
- 深度用现有轻边框和表面色；表单主焦点是连接必填项，已连接详情主焦点是余额或额度。控件使用现有 Button/field；图标只用 lucide-react。

## 页面和配置

六家独立 provider namespace；不改变任何已有服务商的选择、开关或凭据。新 provider 在既有服务商选择页出现，启用与连接检查是两个独立动作；保存成功不等于连接成功。六家配置更改成功后立即清除该连接旧用量和刷新时间；保留真实错误，等新检查完成，迟到的旧来源结果不得恢复。

| Provider | 连接表单 | 主信息与范围 |
|---|---|---|
| Claude Platform | Session Cookie（secret，必填）、Organization ID（secret，可选；有多个 API 组织时必须指定） | Console API 账单，Prepaid Balance、订阅赠送/购买 credit 分开；This Month Spend 标 UTC，权限不足仅显示该项不可用；赠送到期不画成额度重置。 |
| WorkBuddy | Session Cookie（secret，必填）、User-Agent（text，必填；来自同一次有效账单请求） | 套餐 Credits 总额、可用、预留；Rewards 是其中的奖励部分，只标包含关系，不再相加。首版仅 summary，不展示未经完整分页证明的奖励到期或 reset。 |
| Trae CN | Session Cookie（secret，必填） | 服务端 credits 汇总的 Usage、Used、Total、Remaining；不合并其他账号，未知重置不推测周期。 |
| LiteLLM | Proxy URL（text，必填）、Virtual API Key（secret，必填） | Personal、Member、Team Budget 按范围分列，显示各自消费，不累计；未返回预算仅显示 Spending；不是无限额度或零预算。 |
| SiliconFlow | Region（China / International，沿用高级设置中的 Auto）、API Key（secret，必填） | Auto 读取环境变量，未设置时用中国站；显式地区覆盖环境变量。中国站 CNY / 国际站 USD；切换地区后单独请求新地区，不复用旧地区读数。Balance、Purchased、Bonus 分开，负余额保留；没有额度进度条和重置预测。 |
| Muse Code | 原生设备码授权卡片，不要求用户粘贴内部 token | Session 与 Weekly、套餐；仅使用授权账号的用量。响应中的模型 API Key 不进入界面、配置、日志或缓存。 |

配置表单复用 ProviderConfigFields：secret 已保存时只显示脱敏提示；空草稿保留已有 secret；公开字段可回显。帮助与环境来源说明放现有 Advanced Settings。点击“保存并检查”先保存本 provider 的可见字段，再发出独立检查；错误保留可恢复的已保存配置。不得因其他服务商失败改变这六家或原有账号配置。

五家常规配置页不自动打开浏览器或扫描浏览器资料；需要用户主动提供会话/Key 的字段明确使用名称，不称为“自动登录”。LiteLLM 的自定义地址由宿主约束允许的网络目标，错误显示固定友好原因，不回显认证头或原响应。

## Muse Code 授权卡片

- 未连接：说明“在 Meta 页面输入验证码，授权 Muse Code 用量访问”，主按钮“连接 Meta 账号”。
- 等待授权：显示服务端返回的验证码（tabular numbers、可选中文本）、“复制验证码”“打开 Meta 授权网页”和剩余有效时间；设备码、完整授权链接的敏感查询、access token 不在 UI 状态中。取消为次级按钮。
- 轮询按服务端 interval；slow_down 延长等待，不重复启动授权。等待、慢速等待和用量检查时主按钮禁用，关闭页面或取消会使旧请求失效。
- 授权成功后通过 `/key` 验证该账号身份；身份验证成功才保存新凭据。inactive 或未报告的额度不影响合法连接，额度分别显示 Unavailable，不能补零。重新连接期间旧凭据保留，晚到或取消结果不能覆盖旧连接。
- 已连接：显示非敏感连接状态和“重新连接”；用量更新时间仍在原详情页展示。不显示账号邮箱、原始用户标识或模型 API Key；需要区分账号时沿用已脱敏身份/本地标签契约。
- 已过期：说明“验证码已过期，请重新获取”，按钮“重新连接”。拒绝授权显示“授权未完成，请重新连接”；取消返回未连接/原有已连接状态；网络失败可重试，但不自动切换账号或读取旧 CLI 登录。

## 状态与可访问性

| 状态 | 界面行为 |
|---|---|
| Missing | 显示连接入口，值为空而非零。 |
| Checking | 有文字状态和 LoaderCircle；禁用重复操作，保留已有可读用量。 |
| Ready | 仅真实检查成功后显示连接成功和该次更新时间。 |
| Partial | 保留可用余额/额度；单独说明无权限或暂不可用的消费项，整体不伪装为全量成功。 |
| Empty | 明确显示暂无用量记录或未返回该额度，区分有效零值。 |
| Expired | 显示重新连接入口，保留上次有效数据并标旧时间，不当成无账号。 |
| Error | 原有错误区显示友好原因；诊断只含脱敏类别和引用编号，未知数据不补零。 |

所有按钮和输入可用键盘操作，有 label、aria-live 状态；焦点可见。浅/深色和320/400px检查无横向溢出。减弱动效时不旋转等待图标，保留等待文字。

## 原型与验收

交互原型：[new-providers-2026-11-06.html](new-providers-2026-11-06.html)。顶部工具是设计演示控制，不属于产品。
原型数据均为合成，包含六家连接/详情、深浅色、320/400px，以及 missing/checking/ready/partial/expired/error 状态。实际实现继续使用生产组件；设计截图不能替代真实 API 验收。

前端落点：现有连接/恢复配置目录与常规 ProviderCard；Muse 增加小型专用授权卡片与 IPC 包装，不改通用账号架构。后端 IPC 参数一律 camelCase，调用接口由原生实现确定后同步。

文档计划：`README.md`、`docs/providers/claude-platform.md`、`docs/providers/workbuddy.md`、`docs/providers/trae-cn.md`、`docs/providers/litellm.md`、`docs/providers/siliconflow.md`、`docs/providers/muse.md`；若新增宿主能力，更新 `docs/plugins/api.md`、`docs/plugins/schema.md`，认证/响应脱敏范围变化更新 `docs/capture-logs.md`。内部设计只保留在 design/。

验收包括配置保存不影响旧账号、各来源明确、401/403/429和部分权限、失败与晚到响应、Muse取消/超时/slow_down/过期及验证后保存、敏感字段日志审计、生产组件截图、320/400px浅深色以及相关单测/构建。发布和真实账号验收单独记录。

## Muse IPC Contract

- `start_muse_login()` 返回 `loginId`、`userCode`、`verificationUri`、待授权会话的 `expiresAt`（毫秒）和 `intervalSeconds`。原生校验授权网址为 Meta 的 HTTPS 域。
- `poll_muse_login({ loginId })` 返回 `pending`、`slowDown` 或 `succeeded`，可带新的 `intervalSeconds`；拒绝、过期、取消、配置变更由固定友好错误表示。
- `cancel_muse_login({ loginId })` 取消当前待完成会话；离页和新会话均使旧回调失效。
- 成功后先发布本 provider 配置变更事件以废弃旧用量/检查，再通过 `onSaved('muse')` 检查额度并重新读取脱敏配置。`getProviderConfig('muse').values.accessToken.configured` 仅表示已保存连接。`tokenExpiresAt` 为可选 ISO8601 UTC 文本，和待授权会话的毫秒过期值分开处理。
- Muse 不显示任何手动 token 输入；设备码、access token、邮箱和模型 API Key 不进入 IPC。
