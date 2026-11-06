# Muse Code

查看当前连接 Meta 账号的 Muse Code Session 和 Weekly 订阅额度。
Muse Code 与模型推理 API Key 是不同的凭据来源。

## 连接

在 Muse Code 的连接页选择 **Connect With Meta**，复制设备验证码，打开 Meta 授权页完成登录。
授权期间可以取消；拒绝、过期和限流分别显示，不会自动重新登录。

应用保存自己的 Muse Code 连接，不读取或覆盖 Muse CLI、Cursor、Claude 或其他服务商的登录。
授权 token 不显示在界面中。连接过期后再次选择连接；该协议没有可用的 refresh token，
应用不会猜测或修改第三方凭据。授权期间过期或账号验证失败时，需要重新连接，原有连接保持不变。

Muse 连接使用本地 `providers.json` 的独立配置，按现有配置机制保护和遮蔽；
它不是存放在 Keychain 中的登录。不要分享此配置文件。

## 用量含义

- **Session** 是服务端已报告的五小时额度。
- **Weekly** 是已报告的七天额度。
- 缺失窗口会明确说明未报告，不绘制零用量；只返回一个窗口时保留该窗口。
- 超过 100% 的已报告用量保持原值，不将其改为 100%。
- 没有订阅时显示订阅不可用；有效登录仍可保留，不伪装成认证失败。

读取订阅状态的接口还可能返回模型 API Key 和邮箱；它们不进入用量输出、历史或插件存储。
读取请求使用 `onboard: false`，不发送模型提示，不开通或购买订阅。

## 协议来源

设备授权和额度字段参考固定版本的
[OpenUsage Muse Code 接入](https://github.com/robinebers/openusage/blob/0a3813a964f030c50f8c3f1ed13c2781c1f207e3/Sources/OpenUsage/Providers/Muse/MuseUsageClient.swift)。
接口可能变化，代码及合成用例通过不代表真实账号已验收。
品牌色 `#0064E0` 来自 [Meta 开发者网站](https://dev.meta.ai/) 的公开 accent CSS，图标使用单色品牌标识。

授权提交由原生端通知应用，即使连接页已关闭或刚取消，也会移除旧账号用量。通知只影响提交前的检查；较新的有效用量和检查会保留。取消等待在后台完成，不阻塞应用。授权到期会在配置锁、缓存工作和最终写入后再次核对，过期不会替换已有连接。

等待授权的状态只在变化时播报；倒计时可以读取，不会每秒自动播报。
