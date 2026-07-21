# 发布与更新

这份说明用于维护 OpenUsageCN 的自用发布版本。

## 发布身份

- 应用名称：`OpenUsageCN`
- 包名：`openusagecn`
- 应用标识：`ai.cogine.openusagecn`
- GitHub 仓库：`https://github.com/cogine-ai/OpenUsageCN`
- 更新地址：`https://github.com/cogine-ai/OpenUsageCN/releases/latest/download/latest.json`

`ai.cogine.openusagecn` 是 OpenUsageCN 的新 macOS 应用身份。旧的 `com.sunstory.openusagecn` 构建不会自动升级到这个新身份，也不会和新版本共用 macOS 级别的应用身份。

Tauri updater 公钥写在 `src-tauri/tauri.conf.json`。对应私钥保存在本机：

```text
~/.tauri/openusagecn-updater.key
```

私钥不能提交到仓库。GitHub Actions 发布时，需要把私钥内容配置到 `TAURI_SIGNING_PRIVATE_KEY`。

## GitHub Secrets

macOS 和 Windows updater 都需要：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

macOS 签名和公证还需要：

```text
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

macOS 发布还需要：

1. 运行 `bun run build:release` 或 `bun run build:release -- --skip-stapling`。
2. 运行 `bun run verify:updater-signature`，确认 updater 包能被 `src-tauri/tauri.conf.json` 里的公钥验签。
3. 打包运行应用后，替换 `README.md` 使用的 `screenshot.png`。

Windows 发布还需要：

1. 在 Windows 10 22H2 x64 和当前 Windows 11 x64 上完成安装、托盘、更新和卸载检查。
2. 运行 `bun tauri build --target x86_64-pc-windows-msvc --bundles nsis`。
3. 确认生成 current-user NSIS 安装包、`.nsis.zip` updater 包及其 `.sig`。
4. 运行 `bun run verify:updater-signature`。
5. 为 setup `.exe` 生成并上传 SHA-256 校验文件。

Windows 安装器使用在线 WebView2 bootstrapper。没有 WebView2 Runtime 的电脑需要联网完成安装。

## 发布方式

推送 `vMAJOR.MINOR.PATCH` tag 后，`Publish` workflow 会分别构建 Apple Silicon、Intel 和 Windows x64 包。Windows 产物是只为当前用户安装的 NSIS setup `.exe`，并包含 `.nsis.zip` updater 包、签名和 setup SHA-256。所有平台通过 updater 验签与发布校验后，workflow 才会发布正式 release。

发布失败时，先看 workflow 里的 `Validate release secrets` 和 `Validate app version matches tag` 两步。它们会直接指出缺少的 Secret 或版本不一致问题。

## Windows 未签名安装包

Windows MVP 不要求 Authenticode 证书。未签名安装包仍可安装，但 SmartScreen 可能警告，企业策略或 Smart App Control 也可能直接阻止运行。发布说明和下载页必须明确这一点，并提供 setup `.exe` 的 SHA-256。

用户可在 PowerShell 中校验：

```powershell
Get-FileHash .\OpenUsageCN_*_x64-setup.exe -Algorithm SHA256
```

计算结果必须与同一 Release 中的 `.sha256` 文件完全一致。Tauri updater 自身的 `.sig` 仍是发布硬门槛；SHA-256 不能替代 updater 签名。
