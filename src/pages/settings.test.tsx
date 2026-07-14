import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let latestOnDragEnd: ((event: any) => void) | undefined

const providerConfigMocks = vi.hoisted(() => ({
  getProviderConfig: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfigField: vi.fn(),
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

const defaultProps = {
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
    providerPercentText: "70%",
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
    const checkboxes = screen.getAllByRole("checkbox")
    await userEvent.click(checkboxes[checkboxes.length - 1])
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
    expect(screen.getByText("选择刷新频率")).toBeInTheDocument()
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

  it("renders provider config fields after expanding configurable providers", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: "展开 BigModel CN 配置" }))
    expect(await screen.findByLabelText("API Key")).toBeInTheDocument()
    expect(screen.getByText("留空则使用 BIGMODEL_API_KEY 或 ZHIPUAI_API_KEY 环境变量")).toBeInTheDocument()
  })

  it("renders app theme section with theme options", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("应用主题")).toBeInTheDocument()
    expect(screen.getByText("选择界面外观")).toBeInTheDocument()
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
  })

  it("renders time format section heading", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("时间格式")).toBeInTheDocument()
    expect(screen.getByText("选择 12/24 小时制")).toBeInTheDocument()
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
    expect(screen.getByText("设置菜单栏显示样式")).toBeInTheDocument()
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
