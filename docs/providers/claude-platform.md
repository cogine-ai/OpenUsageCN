# Claude Platform

显示 Claude Console API 组织的预付余额、订阅赠送 API credit、购买 credit 和本月消费。它与 Claude Code／Claude.ai 的订阅额度独立，不共享登录或合计余额。

在连接页填入 `platform.claude.com` 的 Cookie 请求头，其中必须包含 `sessionKey`。也可设置 `CLAUDE_PLATFORM_COOKIE`。推理 API Key 无法代替 Console 账单会话。

如果会话只有一个 API 组织，会使用该组织；存在多个时，必须填写 Organization ID（或 `CLAUDE_PLATFORM_ORGANIZATION_ID`）。指定的组织必须属于当前会话且具有 API 能力，不会因无权限自动改读另一个组织。已保存字段优先于环境变量，秘密字段只显示脱敏提示。

余额和 credit 来自 `/api/organizations/{id}/prepaid/credits`。金额按照响应币种和小数精度显示，不换算汇率，也不把赠送 credit 与总余额重复相加。

- API Credit：最近到期且仍有余额的订阅赠送。
- Purchased Credit：最近到期且仍有余额的购买 credit；全部耗尽时保留最近到期一项。
- Other Credit Grants：其他尚未到期赠送的数量和最近到期信息。
- This Month Spend：同一组织的 UTC 本月消费。该报告暂不可用或权限不足时，余额仍可显示。

Credit 到期使用 UTC 日期，不当作循环额度重置。会话过期或账单权限不足会明确提示；组织名称、邮箱和原始组织标识不进入用量卡片。

这些是 Console 网页使用的非公开接口，可能变化。协议参考：[固定上游实现](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/Sources/CodexBarCore/Resources/Plugins/claudeplatform.js)。自动验证采用合成数据；真实账号账单核对单独验收。
