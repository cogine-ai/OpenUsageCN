# OpenUsageCN

在 macOS 菜单栏查看 AI 编程工具的用量和额度。

![OpenUsageCN Screenshot](screenshot.png)

## 下载

[**下载最新版**](https://github.com/cogine-ai/OpenUsageCN/releases/latest)（macOS，支持 Apple Silicon 和 Intel）

## 主要功能

OpenUsageCN 常驻菜单栏，用一个轻量面板展示各类 AI 编程工具的订阅、额度和使用进度。你不需要反复打开各个服务的后台，就能快速看到当前用量。

- **集中查看。** 把多个 AI 工具的用量放在同一个菜单栏面板里。
- **自动刷新。** 按你设置的间隔自动更新。
- **全局快捷键。** 可以用快捷键从任何地方打开或关闭面板。
- **轻量常驻。** 启动快，不打断当前工作流。
- **插件化服务商。** 新服务通过插件接入，主程序保持稳定。
- **[本地 HTTP API](docs/local-http-api.md)。** 其他本地工具可以从 `127.0.0.1:6736` 读取同一份用量数据，并用 `/health` 检查服务和缓存状态。
- **[代理支持](docs/proxy.md)。** 服务商请求可以走 SOCKS5 或 HTTP 代理。

## 支持的服务商

- [**Alibaba Coding Plan**](docs/providers/alibaba-coding-plan.md)：5 小时、weekly、monthly coding plan quota
- [**Alibaba Token Plan**](docs/providers/alibaba-token-plan.md)：token plan quota、remaining、expires
- [**Amp**](docs/providers/amp.md)：免费额度、奖励额度、credits
- [**Antigravity**](docs/providers/antigravity.md)：全部模型用量
- [**BigModel CN**](docs/providers/bigmodel-cn.md)：session、weekly、web searches、设置页 API Key
- [**Claude**](docs/providers/claude.md)：session、weekly、extra usage、本地 token 用量（ccusage）
- [**Codex**](docs/providers/codex.md)：session、weekly、reviews、credits
- [**Copilot**](docs/providers/copilot.md)：premium、chat、completions
- [**Cursor**](docs/providers/cursor.md)：credits、总用量、auto usage、API usage、on-demand、CLI auth
- [**Factory / Droid**](docs/providers/factory.md)：standard、premium tokens
- [**Gemini**](docs/providers/gemini.md)：Gemini CLI OAuth quota、Pro、Flash、Flash Lite
- [**Grok**](docs/providers/grok.md)：credits used、plan、pay-as-you-go cap
- [**JetBrains AI Assistant**](docs/providers/jetbrains-ai-assistant.md)：quota、remaining
- [**Kiro**](docs/providers/kiro.md)：credits、bonus credits、overages
- [**Kimi Code**](docs/providers/kimi.md)：session、weekly
- [**MiniMax**](docs/providers/minimax.md)：coding plan session
- [**OpenAI API**](docs/providers/openai-api.md)：organization spend、requests、tokens、legacy credits
- [**OpenCode**](docs/providers/opencode.md)：opencode.ai session、weekly subscription usage
- [**OpenCode Go**](docs/providers/opencode-go.md)：5h、weekly、monthly spend limits
- [**OpenRouter**](docs/providers/openrouter.md)：credits、balance、key usage
- [**Perplexity**](docs/providers/perplexity.md)：balance、usage analytics、本地 app session
- [**Synthetic**](docs/providers/synthetic.md)：subscription、search、weekly token、5h limits
- [**Devin**](docs/providers/devin.md)：weekly quota、extra usage
- [**Z.ai**](docs/providers/zai.md)：session、weekly、web searches、设置页 API Key

## 参与项目

OpenUsageCN 的服务商通过插件接入。新增或调整服务商时，优先查看 [Plugin API](docs/plugins/api.md)，并保持改动聚焦。

- **新增服务商。** 参考现有插件和 [Plugin API](docs/plugins/api.md)。
- **修复问题。** 尽量说明问题原因，并在适合时补充回归测试。
- **提出需求。** 可以在 [GitHub Issues](https://github.com/cogine-ai/OpenUsageCN/issues/new) 描述你的使用场景。

## 项目来源

OpenUsageCN 基于 OpenUsage 二次开发，并面向中文本地化使用场景调整。项目也参考了 [CodexBar](https://github.com/steipete/CodexBar) 的产品方向。

## 许可证

[MIT](LICENSE)

---

<details>
<summary><strong>从源码运行</strong></summary>

> **提示**：`main` 分支可能包含尚未发布的改动。正式使用时优先选择已发布版本。

### 开发

```bash
bun install
bun run dev
```

### 构建

```bash
bun run build
bun tauri build
```

### 发布

维护自用发布版本时，参考 [发布与更新](docs/release.md)。

</details>
