# Cursor Shared Weekly Quota

日期：2026-11-03。范围：v0.6.45 后的下一批 Cursor 后端改进。先定义指标与显示，再实现；不增加连接流程或修改账号选择。

## 已核对来源

- CodexBar `897bff31731bb4b21b105f6e8bf4c32a8a8bf095` 的 `CursorSandUsage.swift`、`CursorUsageFetcher.swift` 和 `CursorSandUsageTests.swift`。
- [Cursor 用量说明](https://cursor.com/help/models-and-usage/usage-limits)。
- 上游真实 Enterprise fixture 的 `membershipType=enterprise`、`limitType=team`，但 Sand 返回 `isUnified=true`。套餐名不能决定协议。

## 指标与界面

现有卡片和详情采用同一排列，无新增组件：

| 旧套餐 | 已确认共享周额度 |
| --- | --- |
| Cursor Models、Other Models | Shared Weekly Usage |
| 详情保留 Monthly Total | 不生成 Monthly Total |
| 独立 Grok Bot | 不重复生成 Grok Bot |
| 独立 Credits、On-demand | 继续保留已有余额和消费，不并入百分比 |

新标题使用 **Shared Weekly Usage**；百分比沿用现有已用/剩余模式和重置时间格式。
托盘候选先保留已有 Credits 的优先级，周额度与旧 Total 的优先级同为 2；二者不会同时输出。
周额度标为 weekly 候选；偏好周额度时仅能选到实际存在的共享周池，旧套餐仍使用已有候选回退。
错误继续使用现有状态区域：401 为会话失效，403 为访问拒绝，不新增恢复按钮。

## 后端契约

- 同一账号的 Sand 响应必须明确 `isUnified=true`，明确存在付费 included allowance，`usagePercent` 有限且非负，`nextResetTimestampUtc` 有效且在未来。
- `includedLimitZero` 优先于 `hasNonZeroIncludedLimit`。试用、pooled enterprise allowance、缺失标志或无有效 reset 都不能推断成周额度。
- 共享周额度使用独立稳定资源键 `weekly`，百分比上限 100、周期 604800000 毫秒。旧 `totalUsage`、`autoUsage`、`apiUsage`、`grokBotUsage` 不改含义。
- 有效 legacy Requests 优先。没有有效 Requests 时，满足条件的共享周额度替换三个旧月度池和重复 Grok Bot；其他余额、消费保留。
- 每次刷新只请求一次 Sand。Desktop/CLI 仍使用选定 token，浏览器仍使用绑定 profile 的 Cookie；不扫描其他账号、不新增凭据写回。
- 已有可用月额度在可选 Sand 失败时保持原行为；无主额度时不能伪造零用量。基础响应损坏或账号验证失败不得被可选额度掩盖。
- 新周额度不是月账期证据。Model Usage 继续使用已验证月账期，否则采用既有最多 30 天窗口，不能从周 reset 推导月账期。
- CLI/HTTP 输出 `weekly`，`guard cursor --window weekly` 直接读取该资源；独立 Grok Bot 不能代替共享周额度放行。

## 验证与文档

同一组合成 Sand fixture 驱动 Desktop/CLI 和浏览器测试，覆盖统一/旧套餐、Enterprise、有效 Requests、trial、pooled、无 reset、未知标志、零/超额/非法百分比、失败保留其他额度；补日志字段审计、机器接口投影、guard 和历史账期隔离测试。

行为文档：`docs/providers/cursor.md`、`docs/usage-history.md`、`docs/local-http-api.md`、`docs/cli.md`、`docs/capture-logs.md`；插件能力说明涉及变化时更新 `docs/plugins/api.md`。核对 README 插件清单。

本批不新增额外月消费 endpoint；`creditsUsedCents` 不混入已有余额或用量。Ollama API Key、OpenRouter 管理 Key、Antigravity 多池和 ChatGPT 日报仍按上游评估逐项设计后实施。本文件不宣称这些能力已经完成。
