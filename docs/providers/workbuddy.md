# WorkBuddy

查看 WorkBuddy 中国站用量页报告的 credits、预留 credits，以及总额度中的奖励部分。

## 连接

打开 WorkBuddy 的连接设置，在已登录的 [用量页](https://www.workbuddy.cn/profile/plans-usage)
请求中复制 **Cookie** 和同一请求的 **User-Agent**，保存后检查连接。
两项必须来自同一会话；WorkBuddy 会检查它们是否匹配。

也可以在应用启动前设置 `WORKBUDDY_COOKIE` 和 `WORKBUDDY_USER_AGENT`。
设置中已保存的非空值优先。请求失败不会改用另一个账号或另一来源。

凭据按 WorkBuddy 的独立配置保存，界面遮蔽 Cookie。应用不读取、解密或改写 WorkBuddy
桌面端的登录文件，也不会自动扫描浏览器账号。不要分享 Cookie 或原始请求日志。

## 用量含义

- **Credits** 是服务端所有 credits 额度包的总用量与总额。
- **Reserved** 是已报告的预留 credits。
- **Rewards** 是 Credits 中的奖励部分，不能再加到 Credits 上。
- 奖励详情不可读时，保留有效的 Credits，并明确显示奖励详情不可用。
- 未报告额度不会显示为零；明确报告总额为零时，显示数量而不绘制百分比。
- 结转使剩余超过当前总额时，用量显示为零，并另列服务端报告的剩余数量，不丢弃结转余额。

本版只读取汇总，不推测套餐重置时间、奖励到期或固定月周期。
奖励可能分批到期，因此没有奖励重置倒计时。

401 提示检查会话与 User-Agent；403 表示访问被拒绝，限流和网络错误分别显示。
刷新不会发送模型请求或购买、消耗 credits。

## 协议来源

这是未公开的网页接口，可能变动。实现参考固定版本的
[CodexBar WorkBuddy 协议](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/docs/workbuddy.md)。
品牌图标来自该版本对官方品牌标识的单色适配，使用 `currentColor`。
