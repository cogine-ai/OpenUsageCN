# Trae CN

查看 Trae 中国站当前 credits 的已用、总额和剩余数量。国际站账号不适用于此连接。

## 连接

先登录 [Trae 中国站控制台](https://www.trae.cn/dashboard)，从控制台 API 请求复制 Cookie，
在 Trae CN 的连接设置中保存并检查。也可以在应用启动前设置 `TRAE_CN_COOKIE`；设置中的
非空 Cookie 优先。验证失败不会自动切换到环境变量或其他账号。

Cookie 保存在独立的 Trae CN 配置中，界面遮蔽显示。
应用不会改写 Trae 桌面端登录，也不会自动合并不同浏览器会话。

## 用量含义

应用先用会话换取短期 token，再读取同一中国站 API 的 credits 汇总。
短期 token 只在本次刷新中使用，不写入文件，也不发送给其他服务商。

**Usage** 是已用 credits 与总额。**Used**、**Total**、**Remaining** 保留具体数量；
总额为零时不绘制百分比。缺失数字或未知计费模式明确报错，不解释为零用量。

不同额度包可能分别到期，应用不将其中某个到期时间当作全部额度的重置时间，
也不推测月度周期。读取不会发送模型请求、购买或消耗 credits。

401 或服务端明确拒绝会话时需要重新连接；403 显示访问被拒绝。
网络问题、限流和响应格式变动会分别提示。

## 协议来源

网页接口未公开，可能变动。实现参考固定版本的
[CodexBar Trae CN 插件](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/Sources/CodexBarCore/Resources/Plugins/traecn.js)。
两步读取固定在 `api.trae.cn`，不会向国际站或自定义地址转发 Cookie。
