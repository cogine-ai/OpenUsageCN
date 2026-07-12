# 界面术语表

这份表用于 OpenUsageCN 的基础中文化。App 本体和已完成本地化的插件指标应优先使用这里的中文说法；品牌名、命令、环境变量、文件路径、API 名称、GitHub 原文和键盘按键名可以保留英文。

## 核心术语

| 英文 | 中文 |
| --- | --- |
| Provider | 服务商 |
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
| Menubar | 菜单栏 |
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
- 菜单栏小面板文案要短，优先使用“刷新用量”“重置时间”“已暂停”这类直接说法。
- 错误提示应说明用户看到的问题，例如“无法开始刷新”，同时继续在日志里记录详细英文错误。
- 设置页服务商配置状态用“已配置 / 使用默认 / 未配置 / 配置未知”，只描述 OpenUsageCN 当前能判断的配置状态。
