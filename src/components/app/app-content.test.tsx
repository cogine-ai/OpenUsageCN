import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { overviewPageMock, providerDetailPageMock, settingsPageMock, connectionPageMock } = vi.hoisted(() => ({
  overviewPageMock: vi.fn(),
  settingsPageMock: vi.fn(),
  providerDetailPageMock: vi.fn(),
  connectionPageMock: vi.fn(),
}))

vi.mock("@/pages/provider-connection", () => ({
  ProviderConnectionPage: (props: { plugin: { id: string } | null; onCheck: (id: string) => Promise<void>; onAccountChangeRefresh: (id: string) => void }) => {
    connectionPageMock(props)
    return <div data-testid="connection-page">
      <button onClick={() => { if (props.plugin) void props.onCheck(props.plugin.id) }}>check-connection</button>
      <button onClick={() => { if (props.plugin) props.onAccountChangeRefresh(props.plugin.id) }}>refresh-connection-account</button>
      <button onClick={() => useAppUiStore.getState().closeConnection()}>close-connection</button>
    </div>
  },
}))

vi.mock("@/pages/overview", () => ({
  OverviewPage: (props: unknown) => {
    overviewPageMock(props)
    return <div data-testid="overview-page" />
  },
}))

vi.mock("@/pages/settings", () => ({
  SettingsPage: (props: unknown) => {
    settingsPageMock(props)
    return <div data-testid="settings-page" />
  },
}))

vi.mock("@/pages/provider-detail", () => ({
  ProviderDetailPage: (props: {
    onRetry?: () => void
    onAccountChangeRefresh?: () => void
  }) => {
    providerDetailPageMock(props)
    return (
      <div data-testid="provider-detail-page">
        {props.onRetry ? <button onClick={props.onRetry}>retry-provider</button> : null}
        {props.onAccountChangeRefresh ? (
          <button onClick={props.onAccountChangeRefresh}>refresh-account-change</button>
        ) : null}
      </div>
    )
  },
}))

import { AppContent, type AppContentProps } from "@/components/app/app-content"
import { useAppPreferencesStore } from "@/stores/app-preferences-store"
import { useAppUiStore } from "@/stores/app-ui-store"

function createProps(): AppContentProps {
  return {
    platformCapabilities: {
      platform: "macos",
      localHttpApi: true,
      autostart: true,
      cli: true,
      paceNotifications: true,
      globalShortcuts: true,
      nativeTrayTitle: true,
      dynamicTrayIconSettings: true,
    },
    displayPlugins: [],
    settingsPlugins: [],
    selectedPlugin: {
      meta: {
        id: "codex",
        name: "Codex",
        iconUrl: "/codex.svg",
        brandColor: "#000000",
        lines: [],
        primaryCandidates: [],
      },
      data: null,
      loading: false,
      error: null,
      lastManualRefreshAt: null,
      lastUpdatedAt: null,
    },
    onRetryPlugin: vi.fn(),
    onAccountChangeRefreshPlugin: vi.fn(),
    onReorder: vi.fn(),
    onToggle: vi.fn(),
    onProviderConfigSaved: vi.fn(),
    onAutoUpdateIntervalChange: vi.fn(),
    onThemeModeChange: vi.fn(),
    onDisplayModeChange: vi.fn(),
    onResetTimerDisplayModeChange: vi.fn(),
    onResetTimerDisplayModeToggle: vi.fn(),
    onGlobalShortcutChange: vi.fn(),
    onStartOnLoginChange: vi.fn(),
  }
}

describe("AppContent", () => {
  beforeEach(() => {
    overviewPageMock.mockReset()
    settingsPageMock.mockReset()
    providerDetailPageMock.mockReset()
    connectionPageMock.mockReset()
    useAppUiStore.getState().resetState()
    useAppPreferencesStore.getState().resetState()
  })

  it("renders overview page for home view", () => {
    useAppUiStore.getState().setActiveView("home")
    render(<AppContent {...createProps()} />)

    expect(screen.getByTestId("overview-page")).toBeInTheDocument()
    expect(overviewPageMock).toHaveBeenCalledTimes(1)
  })

  it("renders settings page for settings view", () => {
    useAppUiStore.getState().setActiveView("settings")
    render(<AppContent {...createProps()} />)

    expect(screen.getByTestId("settings-page")).toBeInTheDocument()
    expect(settingsPageMock).toHaveBeenCalledTimes(1)
  })

  it("passes retry callback for provider detail view", () => {
    const props = createProps()
    useAppUiStore.getState().setActiveView("codex")
    render(<AppContent {...props} />)

    fireEvent.click(screen.getByRole("button", { name: "retry-provider" }))

    expect(providerDetailPageMock).toHaveBeenCalledTimes(1)
    expect(props.onRetryPlugin).toHaveBeenCalledWith("codex")
  })

  it("passes the dedicated account-change refresh for provider detail", () => {
    const props = createProps()
    useAppUiStore.getState().setActiveView("codex")
    render(<AppContent {...props} />)

    fireEvent.click(screen.getByRole("button", { name: "refresh-account-change" }))

    expect(props.onAccountChangeRefreshPlugin).toHaveBeenCalledWith("codex")
    expect(props.onRetryPlugin).not.toHaveBeenCalled()
  })

  it("renders the connection page over settings and restores settings when closed", () => {
    const props = createProps()
    const plugin = { id: "codex", name: "Codex", enabled: true }
    props.settingsPlugins = [plugin]
    props.displayPlugins = [{ ...props.selectedPlugin!, error: "Session expired" }]
    useAppUiStore.getState().setActiveView("settings")
    useAppUiStore.getState().openConnection("codex", "local")
    render(<AppContent {...props} />)

    expect(screen.getByTestId("connection-page")).toBeInTheDocument()
    expect(settingsPageMock).not.toHaveBeenCalled()
    expect(connectionPageMock).toHaveBeenCalledWith(expect.objectContaining({ plugin, error: "Session expired" }))
    fireEvent.click(screen.getByRole("button", { name: "check-connection" }))
    expect(props.onProviderConfigSaved).toHaveBeenCalledWith("codex")
    expect(props.onRetryPlugin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "close-connection" }))
    expect(screen.getByTestId("settings-page")).toBeInTheDocument()
    expect(screen.queryByTestId("connection-page")).not.toBeInTheDocument()
  })

  it("uses the dedicated account refresh from the connection page", () => {
    const props = createProps()
    props.settingsPlugins = [{ id: "cursor", name: "Cursor", enabled: true, accountSupport: { localDiscovery: true, browserBinding: true, modelHistory: true } }]
    useAppUiStore.getState().openConnection("cursor", "accounts")
    render(<AppContent {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "refresh-connection-account" }))
    expect(props.onAccountChangeRefreshPlugin).toHaveBeenCalledWith("cursor")
    expect(props.onRetryPlugin).not.toHaveBeenCalled()
    expect(overviewPageMock).not.toHaveBeenCalled()
  })

  it("passes a missing provider through so the connection page can offer back navigation", () => {
    useAppUiStore.getState().openConnection("removed-provider", "config", "apiKey")
    render(<AppContent {...createProps()} />)
    expect(connectionPageMock).toHaveBeenCalledWith(expect.objectContaining({ plugin: null }))
    expect(screen.getByTestId("connection-page")).toBeInTheDocument()
  })
})
