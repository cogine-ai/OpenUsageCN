# Existing Provider Design Evidence

这些是第二批现有 Provider 改进的设计原型截图，不是产品实现、安装后验收或真实账号证明。原型使用合成数据，没有外部请求或认证操作。

- `cursor-400-dark.png`：统一周额度与当前用户的月度额外消费分开；不与模型历史相加。
- `claude-400-dark.png`、`claude-bhd-320-light.png`、`claude-usd.png`：Fable 等模型独立周额度，原币种按精度展示；USD 延续现有进度，JPY/BHD 使用精确文本，不扩 metric schema。
- `synthetic-400-dark.png`：新 Weekly 主额度和 Next Regen 分列，不把再生时刻当完整重置。
- `kiro-400-dark.png`：Credits 100/100、Overage Credits 20/50、Bonus Credits 5/10 分离；`kiro-expired.png` 沿用登录恢复入口。
- `zai-320-light.png`、`zai-partial.png`：券数量与带时区的到期时间只读展示，列表不可用不影响主额度。

每家均有 400px 深色、320px 浅色及 Partial 截图。`design-receipt.json` 记录 Chromium 143 对五家 Ready / Partial / Zero / Expired、320/400px、深浅色共 80 组检查，无水平溢出或 pageerror。HMAC Keychain 总超时为纯后端，不为它虚构新界面。

完整设计见 `design/provider-improvements-2026-11-06.md`，可交互原型见相邻同名 HTML。后续实际组件截图与真实接口验收需要在实施批次单独完成。

## Production Before And After

`before-production-*.png` 与 `after-production-*.png` 是真实生产组件，数据来自真实 plugin.probe 的内存 host 执行结果。旧插件冻结在 `674950b06a9432853ce25187ec2ad0e9b38ca297`；既有账号面板和历史区域使用隔离的合成 IPC，不访问本机。

建议审阅以下前后图：

- `before-production-claude-400-dark-detail.png` / `after-production-claude-amounts-320-light.png`：BHD 按 3 位小数展示，不再冒充美元；Fable 和未知模型各有周额度。
- `before-production-long-model-overflow-320-dark.png` / `after-production-long-model-wrapped-320-dark.png`：真实长模型名造成内层滚动宽 635px，局部换行修复后为 320px。
- `before-production-kiro-cli-login-320-light.png` / `after-production-kiro-cli-login-320-light.png`：CLI 固定认证错误有正确登录步骤和复制命令；命令不执行，桌面旧指导保持。
- `after-production-kiro-bonus-320-light.png`：CLI 合计含 bonus，纯主池不可确认时显示 Usage unavailable；overage / bonus 独立，Bonus Expiry 是 text 而非重置。
- `before-production-synthetic-320-light-detail.png` / `after-production-synthetic-320-light-detail.png`：Weekly 取代已淘汰的 5h / Mana，Next Regen 不冒充完全重置。
- `before-production-zai-320-light-detail.png` / `after-production-zai-expiry-320-light.png`：重置券数量与到期分开，Nov 7 00:30 明确 UTC+08:00；`after-production-zai-partial-320-light.png` 保留主额度并仅将券项标不可用。
- `before-production-cursor-400-dark-detail.png` / `after-production-cursor-400-dark-detail.png`：当前用户的月度 On-demand 与 Shared Weekly Usage 独立，未读或合并模型历史账单。

收据按执行版本保留：`before-production-receipt.json` 为 40 个基线场景；`after-production-receipt.json` 为首轮 93 个场景；`after-production-followup-receipt.json` 为 Claude/Kiro 后续源码更改后 45 个受影响场景复验。最终小范围 13 项见 `final-targeted-receipt.json`，包括重新截取登录页顶部及奖励到期完整可见。40/93/45 轮的浏览器收据均无 pageerror、console error 或外部请求；after 轮同时检查页面根与真实滚动容器的水平尺寸。后续收据的源码 SHA256 覆盖最终插件和前端，避免把旧版本结果当成新版本验收。

`production-probe-output-fixtures.json` 与 `before-production-probe-output-fixtures.json` 保留脱敏合成输出、manifest 和请求路由收据；请求仅进入内存 mock，没有实际发往这些 URL。JPY/BHD/USD、零消费、无正上限、第二个 Cursor 合成账号、未知长模型、部分再生元数据、Kiro bonus 主池未知、Z.ai 空券/拒绝等均有覆盖。

这仍不是原生 QuickJS/安装后/真实账号验收，HMAC Keychain 操作与原生 source-scoped 缓存不在浏览器证据范围。UI 命令复制使用模拟适配器，不写系统剪贴板。临时可复现夹具位于本机 `~/.codex/visualizations/2026/11/02/01a19afe-e22d-7d52-a8c7-c395af393e72/provider-improvements-qa/`，不进入产品构建。
