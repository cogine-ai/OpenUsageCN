# 参与 OpenUsageCN

OpenUsageCN 欢迎聚焦的贡献，尤其是能改善 AI 编程工具用量追踪的改动。

## 基本原则

- 改动尽量聚焦在用量追踪和桌面体验上。
- Bug 修复或服务商插件改动能覆盖测试时，应补充测试。
- UI 改动需要提供前后截图。
- 实现应保持简单，并尽量沿用现有代码风格。
- 一个 PR 只处理一类问题。

## 新增服务商插件

每个服务商都是一个插件。完整接口见 [Plugin API](docs/plugins/api.md)。

1. 在 `plugins/` 下创建服务商目录。
2. 添加 `plugin.json` 元数据和 `plugin.js` 实现。
3. 在 `docs/providers/` 中补充说明。
4. 用 `bun tauri dev` 本地测试。
5. 提交 PR，并附上插件正常工作的截图。

## 修复 Bug

1. 说明问题原因和修复方式。
2. 适合时补充回归测试。
3. UI 问题请附截图。
4. 提交 PR 前运行 `bun run build` 和 `bun run test`。

## 代码规范

- `src/` 中的前端代码使用 TypeScript。
- `src-tauri/` 中的后端代码使用 Rust。
- 新增依赖需要说明理由。
- 遵守 [AGENTS.md](AGENTS.md) 中的项目约定。

## 维护者

维护和发布由 [OpenUsageCN 仓库](https://github.com/cogine-ai/OpenUsageCN) 管理。
