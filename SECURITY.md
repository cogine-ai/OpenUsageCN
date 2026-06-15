# 安全政策

## 报告安全问题

如果你发现 OpenUsageCN 的安全问题，请私下报告。不要为安全敏感问题创建公开 Issue。

请使用 [GitHub Security Advisories](https://github.com/cogine-ai/OpenUsageCN/security/advisories/new)，并提供足够信息，方便维护者复现和评估。

## 建议包含的信息

- 问题描述
- 复现步骤
- 受影响版本
- 影响范围

## 范围

以下内容在范围内：

- OpenUsageCN 桌面应用
- OpenUsageCN 内置服务商插件
- 构建和发布基础设施

## 本地 Provider 配置

通过设置页填写的 Provider API Key 会以明文保存在 `~/.openusagecn/providers.json`。OpenUsageCN 会尽量使用私有文件权限保护该文件（macOS/Linux 为 `0600`），但不会加密这些值。

以下内容不在范围内：

- 第三方服务商 API
- 社会工程攻击
- 拒绝服务攻击

## 支持版本

OpenUsageCN 只为最新发布版本提供安全更新。
