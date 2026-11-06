# LiteLLM

显示自己虚拟 Key 所属的个人、团队成员和团队预算。这些范围分别显示，不相加；团队预算是该 Key 的默认菜单栏主候选。

在连接页填写 Proxy URL 和 Virtual API Key，也可设置 `LITELLM_BASE_URL` 与 `LITELLM_API_KEY`。已保存字段优先。只需虚拟 Key，不要求提供管理主 Key。

Key 仅发送到填写的网关，HTTP 请求不跟随重定向。地址支持 `/v1` 后缀，也可包含部署路径。HTTPS 可用于明确配置的网关；HTTP 仅支持本机、私有网络和 `.local` 地址。不接受网址内嵌账号密码、查询或片段。

先通过 `/key/info` 确定 Key 的用户／团队，再读取对应 `/user/info` 和 `/team/info`，并验证返回的身份。成员预算只配同一用户在同一团队内的消费，不用用户总消费替代。

有有效预算时显示 USD 金额进度；未返回预算时只显示已报告消费，不显示零分母或无限额度。重置时间只使用服务端日期，不猜周期。可选团队／成员信息读取失败时，保留已验证的其他预算，并显示不可用提示。

如果网关不开放 `/key/info`，可读取虚拟 Key 自身可访问的 `/key/spend/report`，必要时使用 `/user/spend/report`。这时只显示当前 UTC 月初至今日的 Key Spend 或 User Spend，不虚构预算、剩余比例、重置时间或身份。不会传入其他用户或 Key 的覆盖参数。

本次接入不加载模型历史、推理请求或管理接口。请求受共同时间上限约束，错误不回显响应正文、Key 名称、邮箱或原始用户／团队 ID。

协议参考：[LiteLLM 虚拟 Key](https://docs.litellm.ai/docs/proxy/virtual_keys)、[固定上游实现](https://github.com/steipete/CodexBar/blob/197025e12e41c451899b66aa897423b550e06344/Sources/CodexBarCore/Resources/Plugins/litellm.js)。各网关开放的接口可能不同，真实部署验收单独记录。
