# 五处交互优化的截图与验证

截图拍摄于 2026-10-11。每组左侧是基线 `5150b36` 的源码组件，右侧是本次提交的最终源码组件。两侧使用示例数据和模拟 Tauri IPC，面板宽度为 400px；账号邮箱为示例身份，不含真实凭据。这些是实际组件截图，不代表真实服务商认证成功。

额度截图采用最终确认的原单条横条、周期刻线和状态圆点。上轮双条时间轴方案不属于最终效果。快捷键右侧同时展示已保存键帽和录制状态。

| 优化 | 最终前后截图 |
| --- | --- |
| 连接配置 | [连接页](01-connection-before-after.png) |
| 账号连接 | [来源与身份](02-account-before-after.png) |
| 额度与通知 | [额度](03-quota-before-after.png)、[通知](03-notifications-before-after.png) |
| 错误恢复 | [恢复入口](04-recovery-before-after.png) |
| 快捷键 | [保存与录制](05-shortcut-before-after.png) |

## 本地验证

| 命令或检查 | 结果 |
| --- | --- |
| `bun run test --run` | 128 个文件、1,872 项通过；最终横条修订后的完整测试。 |
| `bun run build` | TypeScript 检查和 Vite 生产构建通过；仍有现有的大分块提示。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` | 最终日志修复后的完整回归：552 项通过，0 失败、0 忽略。 |
| `bun run test:cookie-helper` | 6 个文件、18 项通过。 |
| 本轮涉及的 13 个插件 JS 定向回归 | 13 个文件、131 项通过；这些测试也包含在完整前端与插件测试中。 |
| `python3 -m unittest discover -s scripts -p 'test_verify_cookie_helper_relink_release.py'` | 11 项通过。 |
| `node --test scripts/verify-updater-signature.test.mjs` | 2 项通过。 |
| 本次修改的 Rust 文件格式、`git diff --check` | 通过。全仓库格式检查在未修改的 `log_path.rs`、`provider_accounts/mod.rs`、`webkit_config.rs` 中仍有基线差异，未混入格式清理。 |

回归覆盖隐藏配置不丢失、本次检查与旧批次隔离、关闭页面后仍检查结果、候选账号过期与消耗、身份匹配、失败保留旧读数和成功时间、额度边界、通知去重，以及快捷键注册或保存失败的回滚。插件配置来源声明与环境白名单对应；只有真实必填凭据才阻止提交。环境秘密只返回存在状态和变量名，已保存秘密继续使用遮盖后的提示。

插件日志审计覆盖本次修改声明的 13 个插件及仓库响应样本。新增回归涵盖 OpenAI 项目过滤参数、OpenCode 工作区参数与服务端回包、Gemini 项目回包，以及 reqwest 网络异常再次进入日志时的 URL 遮盖。豆包网关错误说明的遮盖依据[火山引擎官方错误表](https://docs.volcengine.com/docs/APISignatureCallGuide/Commonerrorcode-10?lang=zh)中会回显 Access Key 的错误模板，回归使用测试值，没有向真实账号发送失败请求。修改仅影响日志，服务商请求和用量解析继续使用原始数据。

前一轮 macOS Debug QA 应用已成功打包，并验证配置来源读取、真实缺凭据恢复入口、快捷键注册状态、取消、清除及新组合的保存。最后的单条横条修订通过前端构建与组件截图验证，没有重新打包原生 QA 应用。

## 验证边界

- 真实浏览器发现、服务商账号认证、系统通知授权与发送，以及 Windows 本地运行验收未实测。GitHub CI 结果以 PR 检查为准。
- 快捷键的物理释放、系统级触发和真实冲突未实测。原生自动输入验证了实际注册与持久化，完整事件序列和失败回滚由回归测试验证；重启后新组合的窗口读回因控制工具超时，未计为通过。
- QA 重复启动曾出现一次单实例回调在后台线程显示面板的崩溃。该回调在基线已存在且本次未修改，但没有基线应用运行对照，不能据此宣称生产版本已复现。

QA 使用独立设置，未保存或替换用户的真实服务商凭据。验证后已停止 QA 进程并清理临时设置。
