import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let latestOnDragEnd: ((event: any) => void) | undefined

const providerConfigMocks = vi.hoisted(() => ({
  getProviderConfig: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfigField: vi.fn(),
}))
const toolMocks = vi.hoisted(() => ({ invoke: vi.fn(), health: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: toolMocks.invoke, isTauri: () => true }))
vi.mock("@/lib/local-http-api", async () => ({
  ...await vi.importActual<typeof import("@/lib/local-http-api")>("@/lib/local-http-api"),
  fetchLocalHttpApiHealth: toolMocks.health,
}))

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd?: (event: any) => void }) => {
    latestOnDragEnd = onDragEnd
    return <div data-testid="dnd-context">{children}</div>
  },
  closestCenter: vi.fn(),
  PointerSensor: class {},
  KeyboardSensor: class {},
  useSensor: vi.fn((_sensor: any, options?: any) => ({ sensor: _sensor, options })),
  useSensors: vi.fn((...sensors: any[]) => sensors),
}))

vi.mock("@dnd-kit/sortable", () => ({
  arrayMove: (items: any[], from: number, to: number) => {
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  },
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}))

vi.mock("@/lib/provider-config", () => ({
  getProviderConfig: providerConfigMocks.getProviderConfig,
  saveProviderConfig: providerConfigMocks.saveProviderConfig,
  deleteProviderConfigField: providerConfigMocks.deleteProviderConfigField,
}))

import { SettingsPage } from "@/pages/settings"
import { useAppUiStore } from "@/stores/app-ui-store"

const macosCapabilities = {
  platform: "macos",
  localHttpApi: true,
  autostart: true,
  cli: true,
  paceNotifications: true,
  globalShortcuts: true,
  nativeTrayTitle: true,
  dynamicTrayIconSettings: true,
}

const windowsCapabilities = {
  platform: "windows",
  localHttpApi: true,
  autostart: true,
  cli: false,
  paceNotifications: false,
  globalShortcuts: false,
  nativeTrayTitle: false,
  dynamicTrayIconSettings: false,
}

const defaultProps = {
  platformCapabilities: macosCapabilities,
  plugins: [{ id: "a", name: "Alpha", enabled: true }],
  onReorder: vi.fn(),
  onToggle: vi.fn(),
  onProviderConfigSaved: vi.fn(),
  autoUpdateInterval: 15 as const,
  onAutoUpdateIntervalChange: vi.fn(),
  themeMode: "system" as const,
  onThemeModeChange: vi.fn(),
  displayMode: "used" as const,
  onDisplayModeChange: vi.fn(),
  resetTimerDisplayMode: "relative" as const,
  onResetTimerDisplayModeChange: vi.fn(),
  timeFormatMode: "auto" as const,
  onTimeFormatModeChange: vi.fn(),
  menubarIconStyle: "provider" as const,
  onMenubarIconStyleChange: vi.fn(),
  menubarMetric: "default" as const,
  onMenubarMetricChange: vi.fn(),
  traySettingsPreview: {
    bars: [{ id: "a", fraction: 0.7 }],
    providerBars: [{ id: "a", fraction: 0.7 }],
    providerIconUrl: "icon-a",
    providerText: "70%",
  },
  globalShortcut: null,
  onGlobalShortcutChange: vi.fn(),
  startOnLogin: false,
  onStartOnLoginChange: vi.fn(),
  paceNotifications: {
    almostOut: false,
    closeToLimit: false,
    runningOut: false,
  },
  onPaceNotificationsChange: vi.fn(),
}

beforeEach(() => {
  toolMocks.invoke.mockReset().mockImplementation((command: string) => {
    if (command === "get_global_shortcut_status") return Promise.resolve({ shortcut: null, active: false, error: null })
    if (command === "get_notification_permission" || command === "request_notification_permission") return Promise.resolve("granted")
    if (command === "get_local_http_api_status") return Promise.resolve({ state: "running", bind: "127.0.0.1:6736", startedAt: "2026-10-11T06:00:00Z" })
    if (command === "get_cli_install_status") return Promise.resolve({ available: true, state: "notInstalled", destination: "/usr/local/bin/openusage", message: null })
    throw new Error(`Unexpected command: ${command}`)
  })
  toolMocks.health.mockReset().mockResolvedValue({ status: "ok", providers: { known: 1, enabled: 1, cached: 1 }, cache: { ready: true, lastSuccessfulFetchAt: null } })
  useAppUiStore.getState().resetState()
  providerConfigMocks.getProviderConfig.mockReset()
  providerConfigMocks.getProviderConfig.mockResolvedValue({ values: {} })
  providerConfigMocks.saveProviderConfig.mockReset()
  providerConfigMocks.saveProviderConfig.mockResolvedValue(undefined)
  providerConfigMocks.deleteProviderConfigField.mockReset()
  providerConfigMocks.deleteProviderConfigField.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("SettingsPage", () => {
  it("hides unsupported Windows settings while retaining core settings", async () => {
    render(
      <SettingsPage
        {...defaultProps}
        platformCapabilities={windowsCapabilities}
      />
    )

    expect(screen.queryByText("额度通知")).not.toBeInTheDocument()
    expect(screen.queryByText("菜单栏图标")).not.toBeInTheDocument()
    expect(screen.queryByText("全局快捷键")).not.toBeInTheDocument()
    expect(screen.queryByText("命令行")).not.toBeInTheDocument()
    expect(screen.queryByText(/Cmd|Opt/)).not.toBeInTheDocument()
    expect(screen.queryByText("本地 API")).not.toBeInTheDocument()
    expect(toolMocks.invoke).not.toHaveBeenCalledWith("get_local_http_api_status")
    await userEvent.click(screen.getByRole("button", { name: "工具接入" }))
    expect(await screen.findByText("运行中")).toBeVisible()
    expect(screen.getByRole("heading", { name: "本地 API" })).toBeVisible()
    expect(screen.getByText("http://127.0.0.1:6736")).toBeVisible()
    expect(screen.queryByRole("button", { name: "安装命令" })).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "登录时启动" })).toBeInTheDocument()
    expect(screen.getByText("自动刷新")).toBeInTheDocument()
    expect(screen.getByText("用量显示")).toBeInTheDocument()
    expect(screen.getByText("应用主题")).toBeInTheDocument()
    expect(screen.getAllByRole("heading")[0]).toHaveTextContent("服务商")
  })

  it("mounts supported Mac tool settings only while expanded", async () => {
    render(<SettingsPage {...defaultProps} />)
    const toggle = screen.getByRole("button", { name: "工具接入" })
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(panel).toBeEmptyDOMElement()
    expect(toolMocks.invoke).not.toHaveBeenCalledWith("get_local_http_api_status")
    expect(toolMocks.invoke).not.toHaveBeenCalledWith("get_cli_install_status")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("heading", { name: "本地 API" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "命令行" })).toBeVisible()
    await waitFor(() => expect(screen.getByRole("button", { name: "安装命令" })).toBeEnabled())
    expect(toolMocks.invoke).toHaveBeenCalledWith("get_local_http_api_status")
    expect(toolMocks.invoke).toHaveBeenCalledWith("get_cli_install_status")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(panel).toBeEmptyDOMElement()
    expect(screen.queryByRole("heading", { name: "本地 API" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "安装命令" })).not.toBeInTheDocument()
  })

  it.each([null, { ...windowsCapabilities, localHttpApi: false }])("omits tool access when no tool capability is supported", (platformCapabilities) => {
    render(<SettingsPage {...defaultProps} platformCapabilities={platformCapabilities} />)
    expect(screen.queryByRole("button", { name: "工具接入" })).not.toBeInTheDocument()
    expect(toolMocks.invoke).not.toHaveBeenCalledWith("get_local_http_api_status")
    expect(toolMocks.invoke).not.toHaveBeenCalledWith("get_cli_install_status")
  })

  it("toggles plugins", async () => {
    const onToggle = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        plugins={[
          { id: "b", name: "Beta", enabled: false },
        ]}
        onToggle={onToggle}
      />
    )
    await userEvent.click(screen.getByRole("checkbox", { name: "启用 Beta" }))
    expect(onToggle).toHaveBeenCalledWith("b")
  })

  it("reorders plugins on drag end", () => {
    const onReorder = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        plugins={[
          { id: "a", name: "Alpha", enabled: true },
          { id: "b", name: "Beta", enabled: true },
        ]}
        onReorder={onReorder}
      />
    )
    latestOnDragEnd?.({ active: { id: "a" }, over: { id: "b" } })
    expect(onReorder).toHaveBeenCalledWith(["b", "a"])
  })

  it("ignores invalid drag end", () => {
    const onReorder = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onReorder={onReorder}
      />
    )
    latestOnDragEnd?.({ active: { id: "a" }, over: null })
    latestOnDragEnd?.({ active: { id: "a" }, over: { id: "a" } })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it("updates auto-update interval", async () => {
    const onAutoUpdateIntervalChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onAutoUpdateIntervalChange={onAutoUpdateIntervalChange}
      />
    )
    await userEvent.click(screen.getByText("30 分钟"))
    expect(onAutoUpdateIntervalChange).toHaveBeenCalledWith(30)
  })

  it("shows auto-update helper text", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.queryByText("选择刷新频率")).not.toBeInTheDocument()
  })

  it("updates quota notification toggles", async () => {
    const onPaceNotificationsChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onPaceNotificationsChange={onPaceNotificationsChange}
      />
    )

    await userEvent.click(screen.getByRole("checkbox", { name: "接近上限" }))
    expect(onPaceNotificationsChange).toHaveBeenCalledWith({
      almostOut: false,
      closeToLimit: true,
      runningOut: false,
    })
  })

  it("opens a configurable provider's independent connection page from the first settings group", async () => {
    render(
      <SettingsPage
        {...defaultProps}
        plugins={[
          {
            id: "bigmodel-cn",
            name: "BigModel CN",
            enabled: true,
            config: {
              fields: [
                {
                  id: "apiKey",
                  type: "secret",
                  label: "API Key",
                  placeholder: "key.secret",
                  help: "留空则使用 BIGMODEL_API_KEY 或 ZHIPUAI_API_KEY 环境变量",
                  options: [],
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getAllByRole("heading")[0]).toHaveTextContent("服务商")
    await userEvent.click(screen.getByRole("button", { name: "连接 BigModel CN" }))
    expect(useAppUiStore.getState().connection).toEqual({ providerId: "bigmodel-cn", kind: "config" })
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument()
    expect(screen.queryByText("留空则使用 BIGMODEL_API_KEY 或 ZHIPUAI_API_KEY 环境变量")).not.toBeInTheDocument()
  })

  it("renders app theme section with theme options", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("应用主题")).toBeInTheDocument()
    expect(screen.queryByText("选择界面外观")).not.toBeInTheDocument()
    expect(screen.getByText("跟随系统")).toBeInTheDocument()
    expect(screen.getByText("浅色")).toBeInTheDocument()
    expect(screen.getByText("深色")).toBeInTheDocument()
  })

  it("updates theme mode", async () => {
    const onThemeModeChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onThemeModeChange={onThemeModeChange}
      />
    )
    await userEvent.click(screen.getByText("深色"))
    expect(onThemeModeChange).toHaveBeenCalledWith("dark")
  })

  it("updates display mode", async () => {
    const onDisplayModeChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onDisplayModeChange={onDisplayModeChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: "剩余" }))
    expect(onDisplayModeChange).toHaveBeenCalledWith("left")
  })

  it("updates reset timer display mode", async () => {
    const onResetTimerDisplayModeChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onResetTimerDisplayModeChange={onResetTimerDisplayModeChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: /具体时间/ }))
    expect(onResetTimerDisplayModeChange).toHaveBeenCalledWith("absolute")
  })

  it("renders renamed usage section heading", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("用量显示")).toBeInTheDocument()
  })

  it("renders reset timers section heading", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("重置时间")).toBeInTheDocument()
    expect(screen.queryByText("倒计时或具体时间")).not.toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /5 小时 12 分钟/ })).toBeInTheDocument()
  })

  it("renders time format section heading", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("时间格式")).toBeInTheDocument()
    expect(screen.queryByText("选择 12/24 小时制")).not.toBeInTheDocument()
  })

  it("updates time format mode to 12h", async () => {
    const onTimeFormatModeChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onTimeFormatModeChange={onTimeFormatModeChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: "12 小时" }))
    expect(onTimeFormatModeChange).toHaveBeenCalledWith("12h")
  })

  it("updates time format mode to 24h", async () => {
    const onTimeFormatModeChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onTimeFormatModeChange={onTimeFormatModeChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: "24 小时" }))
    expect(onTimeFormatModeChange).toHaveBeenCalledWith("24h")
  })

  it("renders menubar icon section", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("菜单栏图标")).toBeInTheDocument()
    expect(screen.queryByText("设置菜单栏显示样式")).not.toBeInTheDocument()
  })

  it("clicking Bars triggers onMenubarIconStyleChange(\"bars\")", async () => {
    const onMenubarIconStyleChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onMenubarIconStyleChange={onMenubarIconStyleChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: "条形" }))
    expect(onMenubarIconStyleChange).toHaveBeenCalledWith("bars")
  })

  it("clicking Donut triggers onMenubarIconStyleChange(\"donut\")", async () => {
    const onMenubarIconStyleChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onMenubarIconStyleChange={onMenubarIconStyleChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: "圆环" }))
    expect(onMenubarIconStyleChange).toHaveBeenCalledWith("donut")
  })

  it("renders the menubar metric control", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("指标")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "默认" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "每周" })).toBeInTheDocument()
  })

  it("clicking Weekly triggers onMenubarMetricChange(\"weekly\")", async () => {
    const onMenubarMetricChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onMenubarMetricChange={onMenubarMetricChange}
      />
    )
    await userEvent.click(screen.getByRole("radio", { name: "每周" }))
    expect(onMenubarMetricChange).toHaveBeenCalledWith("weekly")
  })

  it("does not render removed bar icon controls", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.queryByText("Bar Icon")).not.toBeInTheDocument()
    expect(screen.queryByText("Show percentage")).not.toBeInTheDocument()
  })

  it("toggles start on login checkbox", async () => {
    const onStartOnLoginChange = vi.fn()
    render(
      <SettingsPage
        {...defaultProps}
        onStartOnLoginChange={onStartOnLoginChange}
      />
    )
    await userEvent.click(screen.getByRole("checkbox", { name: "登录时启动" }))
    expect(onStartOnLoginChange).toHaveBeenCalledWith(true)
  })
})
