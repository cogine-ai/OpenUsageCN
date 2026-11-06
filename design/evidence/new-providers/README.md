# Six Provider Visual Evidence

设计在产品实现前完成并由主任务审阅。`design-*.png` 来自交互设计原型；`after-production-*.png` 使用真实 AppContent、Settings、ProviderConnection、ProviderConfigFields、ProviderDetail 和 MuseConnection 组件。

- 对比：`before-production-catalog-dark.png` / `after-production-catalog-dark.png`。相同现有设置组件，基线 29 个服务商与新增后 35 个服务商；原有项目的配置和开关不变。
- 授权：`after-production-muse-pending-dark.png`、`after-production-muse-pending-320-light.png`、`after-production-muse-verified-dark.png`、`after-production-muse-expired-320-light.png`。
- 常规表单：六家均有 `after-production-*-connect-dark.png` 与 `after-production-*-connect-320-light.png`。
- 用量范围：`after-production-*-detail-dark.png` 展示分离的额度池或余额，其中 LiteLLM 的个人/团队预算不相加，SiliconFlow 保留负余额。

浏览器收据见 `production-receipt.json`：Chromium 143，131 个实际组件场景，320/400px、深浅色，无水平溢出、页面/控制台错误或外部网络请求。通用表单保存只写对应 namespace，原有两份合成配置和开关未变，配置变更事件先于新用量检查。Muse 验证了公开验证码复制、经原生约束地址的打开意图、轮询成功后的单次检查、取消、过期连接保留；取消/晚到/slowDown/配置切换隔离的深入回归由组件和 hook 测试覆盖。

所有凭据、用量、Meta 授权和 IPC 都是合成数据；系统剪贴板和打开网页也使用独立模拟适配器。截图不是安装后验收，也不证明真实服务商接口/账号访问成功。没有读取本机 Keychain、修改已有登录或访问真实账号。图片为 2 倍像素，CSS 面板大小为 320×500 或 400×500。

可复现夹具保留在本机 `~/.codex/visualizations/2026/11/02/01a19afe-e22d-7d52-a8c7-c395af393e72/new-providers-qa/`，不进入产品构建。初次开发模式重载产生的测试夹具重复挂载提示已通过关闭该夹具的 HMR 消除；最终收据为重新验收后的干净结果。

## Muse Review Follow-Up

PR #268 审查后，授权保存改由原生端发全局通知。即使关闭连接页或取消等待，旧账号数据仍会移除；以提交前最后真实检查的序号为边界，迟到通知不会清除较新的成功用量或检查。Mounted 连接页只重读脱敏连接状态，不自动另起一次检查，也不打断新的授权会话。倒计时拆为非自动播报的 timer，原有视觉结构保持。

`review-followup-muse-pending-dark.png` 和 `review-followup-muse-verified-dark.png` 是真实 AppContent / MuseConnection 的轻量复验截图。`review-followup-muse-receipt.json` 记录四个合成场景：pending/timer、尊重 slowDown 间隔、成功后单次用量检查，以及取消后原生已提交时更新已保存状态、忽略旧 poll。没有 console/pageerror 或外部请求。全局清理与旧/新检查排序由 hook 回归独立验证，浏览器夹具只模拟该内部通知。

本次复用了原截图，未重复原 131 场景。完整当前工作区 176 个测试文件、2568 项通过；这包含后续 provider 批次，不能替代抽取到 PR #268 后的 CI。日志与代码 SHA256 见收据。所有账号和 IPC 仍为合成，未访问真实登录、Keychain 或系统剪贴板。临时夹具在 `~/.codex/visualizations/2026/11/02/01a19afe-e22d-7d52-a8c7-c395af393e72/muse-review-qa/`，服务已停止。
