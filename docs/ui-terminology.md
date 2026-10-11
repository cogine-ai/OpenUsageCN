# 界面术语表

这份表用于 OpenUsageCN 的基础中文化。App 本体和已完成本地化的插件指标应优先使用这里的中文说法；品牌名、命令、环境变量、文件路径、API 名称、GitHub 原文和键盘按键名可以保留英文。

## 核心术语

| 英文 | 中文 |
| --- | --- |
| Provider | 服务商 |
| Provider Accounts | 账号 |
| Add Browser Account | 添加账号 |
| Plugin | 插件 |
| Usage | 用量 |
| Quota | 额度 |
| Limit | 上限 |
| Plan | 套餐 |
| Session | 会话 |
| Weekly | 每周 |
| Monthly | 每月 |
| Daily | 每日 |
| Web Searches | 联网搜索 |
| Dashboard / Console | 控制台 |
| Settings | 设置 |
| Menu Bar | 菜单栏 |
| System Tray | 系统托盘 |
| Global Shortcut | 全局快捷键 |
| Configured | 已配置 |
| Default Config | 使用默认 |
| Unconfigured | 未配置 |
| Unknown Config | 配置未知 |

## 使用约定

- 面向用户选择服务商、查看用量或停用入口时，用“服务商”。
- 只有在描述插件机制、插件列表、插件配置或插件开发时，用“插件”。
- 保留服务商品牌名，例如 Codex、Claude、Cursor、Kiro。
- 已完成本地化的插件指标使用简短中文。窗口含义明确时优先直接写时长，例如 Codex 的 `Session` 显示为“5小时”。
- 技术单位可按产品习惯保留英文，例如 Codex 用量中的 `tokens`。
- 托盘小面板文案要短，优先使用“刷新用量”“重置时间”“已暂停”这类直接说法。
- 平台入口要准确：macOS 使用“菜单栏”，Windows 使用“系统托盘”；泛指两者时使用“托盘入口”或直接说“OpenUsageCN 图标”。
- Windows MVP 不显示暂不支持的入口，包括 CLI、额度通知、全局快捷键、动态托盘图标和托盘标题设置。
- 错误提示应说明用户看到的问题，例如“无法开始刷新”，同时继续在日志里记录详细英文错误。
- 设置页用“已保存 / 已发现凭据 / 连接 / 无法读取”描述当前能判断的配置状态；只有本次检查通过才能显示“连接成功”。
- 设置页的“工具接入”默认收起，展开后才读取本机支持的本地 API 和命令行工具状态。
- “已用 / 剩余”描述当前额度读数，“预计…后用尽”描述预测；超出进度的差额比较当前用量与周期进度，不是预计最终超额。

## Connection And Shortcut Behavior

- 保存并检查 distinguishes saved settings from a verified connection. 已保存 and 已发现凭据 do not mean a connection is valid.
- Esc, leaving the shortcut recorder, or canceling keeps the previous shortcut. 清除 is a separate action. The recorder normally waits for every recorded key to release. For Command combinations, releasing the last modifier also finishes recording because macOS can omit the main key's release event. Multiple main keys are still rejected. The displayed value changes after native registration and persistence succeed. A saved shortcut that failed to register is shown as 未生效.
