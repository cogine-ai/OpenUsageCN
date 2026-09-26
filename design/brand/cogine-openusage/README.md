# Cogine 图标素材

这套素材已复制到 OpenUsageCN 的正式图标路径。`ready/` 保留对应文件，方便核对来源和尺寸。

## 原始素材

- `source/cogine-favicon.svg`：独立 Cogine 品牌图，复制自本机 `CogineLOGOSet/favicon.svg`；SHA-256 为 `2447dfa0709f054b4bf186ae55c93e066edf7014d9b4e18579c1cedfe7422b54`。
- `source/cogine-mark-black.png`：透明底黑色标志，复制自本机 `logo-black-transparent-cogine.png`。
- `source/cogine-mark-padded.svg`：把同一黑色标志放入带留白的 1024 × 1024 画布，供小尺寸图标生成使用。

原始 SVG 内嵌位图，不是真正的矢量路径；透明标志本身是 PNG。Tauri 生成桌面图标时不支持 SVG 中的深浅色 `@media` 规则，因此桌面输出固定为白底黑标志；浏览器 favicon 保留原有深浅色规则。

## 已启用文件

| 位置 | 用途 |
| --- | --- |
| `ready/src-tauri/icons/` | 与当前桌面构建所用图标逐一同名的 PNG、ICNS、ICO 文件，包含 Windows SquareLogo 系列。 |
| `ready/src-tauri/icons/tray-icon.png` | 44 × 44 透明底黑色标志，供 macOS 菜单栏作为模板图标使用。 |
| `ready/src-tauri/icons/tray-icon-windows.png` | 32 × 32 白色圆底黑色标志，供 Windows 系统托盘使用。 |
| `ready/public/favicon.svg` | 浏览器 favicon。 |
| `ready/public/icon.png` | 应用“关于”弹窗使用的 128 × 128 图标。 |
| `ready/public/cogine-mark-48.png` | 导航栏小图的 2 倍尺寸透明蒙版素材，替换时需修改 `src/components/side-nav.tsx`。 |

`preview.png` 是素材在浅色、深色背景上的模拟展示，不是应用运行截图。

`src-tauri/icons/Exported/`、`Icon.icon/`、`android/` 和 `ios/` 是旧素材或移动端素材，当前桌面构建没有引用它们；本次没有改动。

## 核对

1. 正式路径和 `ready/` 中的图标应逐一相同，导航栏使用新蒙版。
2. `README.md` 目前展示本目录的图标预览。旧 `screenshot.png` 保留作历史界面参考；新版本打包运行后再拍摄真实界面截图。
3. 在 macOS 菜单栏、Windows 系统托盘、应用窗口和“关于”弹窗确认实际效果；提交视觉改动的 PR 前提供前后截图。
