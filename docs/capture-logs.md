# 如何为问题反馈收集日志

当 OpenUsageCN 工作异常，需要在 GitHub 问题中补充调试信息时使用这份说明。

- 适用对象：普通用户
- 预计耗时：约 2 分钟
- 平台：macOS

## 1. 将日志级别切到调试

1. 在 macOS 菜单栏找到 OpenUsageCN 图标。
2. 右键点击图标，或按住 `Control` 再点击。
3. 打开 `日志级别`。
4. 选择 `调试`。

如果 OpenUsageCN 完全无法打开，跳过这一步。

## 2. 复现一次问题

1. 再做一次出问题的操作。
2. 等到错误出现。
3. 做 1-2 次即可，避免日志太多。

## 3. 在 Finder 打开日志目录

1. 打开 Finder。
2. 按 `Shift` + `Command` + `G`。
3. 粘贴这个路径：

```text
~/Library/Logs/com.sunstory.openusagecn
```

4. 按 `Enter`。

## 4. 将日志附到 GitHub 问题

1. 附上 `OpenUsageCN.log`。
2. 如果看到 `OpenUsageCN.log.1` 这类文件，也一并附上。
3. 直接把文件拖到 GitHub 问题或评论里。

## 5. 在同一条评论里补充这些信息

复制后填写：

```text
我原本预期：
实际发生：
发生时间（本地时间 + 时区）：
受影响的服务商（Codex / Claude / Cursor / 等）：
OpenUsageCN 版本：
```

## 隐私提醒

日志会自动遮盖常见密钥，但公开发送前仍建议自己检查一遍。

## 可选：切回默认日志级别

发送日志后，可将 `日志级别` 切回 `错误`。
