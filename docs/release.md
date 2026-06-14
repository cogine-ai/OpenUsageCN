# 发布与更新

这份说明用于维护 OpenUsageCN 的自用发布版本。

## 发布身份

- 应用名称：`OpenUsageCN`
- 包名：`openusagecn`
- macOS bundle identifier：`ai.cogine.openusagecn`
- GitHub 仓库：`https://github.com/cogine-ai/OpenUsageCN`
- 更新地址：`https://github.com/cogine-ai/OpenUsageCN/releases/latest/download/latest.json`

`ai.cogine.openusagecn` 是 OpenUsageCN 的新 macOS 应用身份。旧的 `com.sunstory.openusagecn` 构建不会自动升级到这个新身份，也不会和新版本共用 macOS 级别的应用身份。

Tauri updater 公钥写在 `src-tauri/tauri.conf.json`。对应私钥保存在本机：

```text
~/.tauri/openusagecn-updater.key
```

私钥不能提交到仓库。GitHub Actions 发布时，需要把私钥内容配置到 `TAURI_SIGNING_PRIVATE_KEY`。

## GitHub Secrets

发布 workflow 需要这些 Secrets：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
KEYCHAIN_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
```

当前 updater key 设置了密码。GitHub Actions 发布时，需要把密码配置到 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

本机打包时，如果 Apple 证书已经安装在登录钥匙串里，`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`KEYCHAIN_PASSWORD` 可以留空。它们主要用于 GitHub Actions 在临时钥匙串中导入证书。

## 发布前检查

1. 确认 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本一致。
2. 运行 `bun run bundle:plugins`，确认 bundled plugins 包含当前支持的服务商。
3. 运行 `bun run test --run`。
4. 运行 `bun run build`。
5. 运行 `CARGO_NET_GIT_FETCH_WITH_CLI=true cargo test --manifest-path src-tauri/Cargo.toml`。
6. 运行 `bun run build:release` 或 `bun run build:release -- --skip-stapling`。
7. 运行 `bun run verify:updater-signature`，确认 updater 包能被 `src-tauri/tauri.conf.json` 里的公钥验签。
8. 打包运行应用后，替换 `README.md` 使用的 `screenshot.png`。

## 发布方式

推送 `vMAJOR.MINOR.PATCH` tag 后，`Publish` workflow 会构建 Apple Silicon 和 Intel 两个 macOS 包，并上传 updater 所需的 `latest.json` 和 `.sig` 文件。

发布失败时，先看 workflow 里的 `Validate release secrets` 和 `Validate app version matches tag` 两步。它们会直接指出缺少的 Secret 或版本不一致问题。
