# SiliconFlow

显示所选地区账号的 API 余额、购买余额和赠送余额。中国站以人民币显示，国际站以美元显示，不进行汇率换算，也不将余额画成额度百分比。

在连接页选择地区，填入该地区的 API Key，再选择保存并检查。自动来源使用 `SILICONFLOW_REGION`（`china` 或 `international`），缺省为中国站；明确选择的地区优先。Key 可通过 `SILICONFLOW_API_KEY` 提供，已保存的 Key 优先。

每次刷新仅向所选官方地址发送 Bearer `GET /v1/user/info`：

- 中国：`https://api.siliconflow.cn`
- 国际：`https://api.siliconflow.com`

不会调用推理接口或自动尝试另一个地区。切换地区不会合计两个地区的余额。

Balance 是 `totalBalance`，Purchased 是 `chargeBalance`，Bonus 是 `balance`。负余额仍会显示；缺失可选分项不补零。SiliconFlow 没有在此接口返回预算、重置时间或历史账单。

Key 错误、权限不足、限流和余额接口被拒绝会显示具体提示；响应中的邮箱、姓名、头像和用户 ID 不进入用量卡片。

协议参考：[官方 user-info 文档](https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info)。当前自动验证使用合成数据，真实账号账单核对单独验收。
