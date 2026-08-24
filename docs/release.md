# 发布与更新

这份说明用于维护 OpenUsageCN 的自用发布版本。

## 发布身份

- 应用名称：`OpenUsageCN`
- 包名：`openusagecn`
- 应用标识：`ai.cogine.openusagecn`
- GitHub 仓库：`https://github.com/cogine-ai/OpenUsageCN`
- 更新地址：`https://github.com/cogine-ai/OpenUsageCN/releases/latest/download/latest.json`
- macOS 最低版本：`13.0`

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
3. 运行 `bun run test:cookie-helper`，确认浏览器 Cookie helper 的协议和构建输入检查通过。
4. 运行 `bun run test --run`。
5. 运行 `bun run build`。
6. 运行 `CARGO_NET_GIT_FETCH_WITH_CLI=true cargo test --manifest-path src-tauri/Cargo.toml`。

macOS 发布还需要：

1. 分别运行 `bun run build:cookie-helper -- aarch64-apple-darwin` 和 `bun run build:cookie-helper -- x86_64-apple-darwin`，再运行对应的 `bun run verify:cookie-helper-build -- <target>`。验证会检查架构、macOS 13 deployment target、执行权限和协议启动。
2. 发布 workflow 必须通过 `Verify Signed And Notarized Cookie Helper`。它会从 updater archive 重新解包，检查 helper 与应用的 Developer ID、两者都只有 `allow-jit`、macOS 13、第三方通知、stapling、Gatekeeper 和实际协议启动。Tauri 当前把同一个 entitlement 文件应用到主程序和 external binary，因此主程序也获得了只供 Bun helper 使用的 JIT 权限；这是当前发布链路的残余权限风险。如果 Tauri 支持逐可执行文件配置，应改成只授予 helper。
3. 用两个不同的 Cursor 身份验证 Desktop SQLite、CLI Keychain、账号切换和当前账期 Model Usage；切换时不能短暂显示另一个账号的数据。
4. 先用旧版本创建 Provider Accounts 数据和安装密钥，再升级并刷新同一个身份；账号 ID 必须保持不变，也不能出现新增的 Keychain 授权或异常提示。
5. 切换系统 IANA 时区，并用跨夏令时边界的数据验证 Model Usage 的当前窗口和本地日期分组；一次刷新必须使用同一个当前时间。
6. 用 Claude OAuth 账号和匹配的浏览器 profile 验证 Team 席位；不匹配或无法验证时必须保持通用 `Team`。
7. 运行 `bun run build:release` 或 `bun run build:release -- --skip-stapling`。
8. 运行 `bun run verify:updater-signature`，确认 updater 包能被 `src-tauri/tauri.conf.json` 里的公钥验签。
9. 打包运行应用后，替换 `README.md` 使用的 `screenshot.png`。

### Cookie Helper 许可证门槛

Cookie helper 是 Bun 1.3.6 的 standalone executable，包含静态链接的 JavaScriptCore/WebKit。Bun 1.3.6 的上游许可证明确要求分发者提供可让用户修改 JavaScriptCore 并重新链接的材料。仅附带 `THIRD_PARTY_NOTICES.md`、源代码链接或 LGPL 文本不能代替这项义务。

在发布包含 cookie helper 的版本前，必须完成并由许可证负责人确认以下材料：

1. 同时覆盖 Apple Silicon 和 Intel 的、经实际复现的 Bun 1.3.6 与 WebKit `1d0216219a3c52cb85195f48f19ba7d5db747ff7` 重链接流程。
2. 接收者重建 helper 所需的完整对象或源代码、构建数据和工具，以及与发布二进制匹配的校验记录。
3. LGPL v2 要求的许可证副本、显著通知和至少三年的材料提供方式。

当前仓库尚未包含上述重链接材料，因此 cookie helper 的许可证合规仍是发布硬阻塞。上游 Bun 1.3.6 `LICENSE.md` 所列的旧命令也不能直接作为证明：该 tag 没有 `.gitmodules` 或 `Makefile`，而该版本实际改用 CMake，并固定了上面的 WebKit commit。不要在没有复现记录时宣称已经闭环。

Windows 发布还需要：

1. 在 Windows 10 22H2 x64 和当前 Windows 11 x64 上完成安装、托盘、更新和卸载检查。
2. 运行 `bun tauri build --target x86_64-pc-windows-msvc --bundles nsis`。
3. 确认生成 current-user NSIS `*-setup.exe` 及其 updater `.sig`。
4. 运行 `bun run verify:updater-signature`。
5. 为 setup `.exe` 生成并上传 SHA-256 校验文件。

Windows 安装器使用在线 WebView2 bootstrapper。没有 WebView2 Runtime 的电脑需要联网完成安装。

## 发布方式

推送 `vMAJOR.MINOR.PATCH` tag 后，`Publish` workflow 会先创建一份草稿 release，再分别构建 Apple Silicon、Intel 和 Windows x64 包。Windows 的 NSIS `*-setup.exe` 同时作为安装包和 updater 产物，并附带 updater 签名与 setup SHA-256。所有平台通过 updater 验签与发布校验后，workflow 才会发布正式 release。

发布失败时，先看 workflow 里的 `Validate release secrets` 和 `Validate app version matches tag` 两步。它们会直接指出缺少的 Secret 或版本不一致问题。

## Windows 未签名安装包

Windows MVP 不要求 Authenticode 证书。未签名安装包仍可安装，但 SmartScreen 可能警告，企业策略或 Smart App Control 也可能直接阻止运行。发布说明和下载页必须明确这一点，并提供 setup `.exe` 的 SHA-256。

用户可在 PowerShell 中校验：

```powershell
Get-FileHash .\OpenUsageCN_*_x64-setup.exe -Algorithm SHA256
```

计算结果必须与同一 Release 中的 `.sha256` 文件完全一致。Tauri updater 自身的 `.sig` 仍是发布硬门槛；SHA-256 不能替代 updater 签名。
