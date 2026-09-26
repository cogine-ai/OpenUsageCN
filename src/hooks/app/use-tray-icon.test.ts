import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginState } from "@/hooks/app/types"

const trayMocks = vi.hoisted(() => ({
  getByIdMock: vi.fn(),
  setIconMock: vi.fn(),
  setIconAsTemplateMock: vi.fn(),
  setTitleMock: vi.fn(),
  setTooltipMock: vi.fn(),
  resolveResourceMock: vi.fn(),
  renderTrayBarsIconMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: {
    getById: trayMocks.getByIdMock,
  },
}))

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: trayMocks.resolveResourceMock,
}))

vi.mock("@/lib/tray-bars-icon", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tray-bars-icon")>("@/lib/tray-bars-icon")
  return {
    ...actual,
    renderTrayBarsIcon: trayMocks.renderTrayBarsIconMock,
  }
})

import { useTrayIcon } from "@/hooks/app/use-tray-icon"

const pluginsMeta: PluginMeta[] = [
  {
    id: "codex",
    name: "Codex",
    iconUrl: "icon-codex",
    primaryCandidates: ["Session"],
    lines: [],
  },
  {
    id: "claude",
    name: "Claude",
    iconUrl: "icon-claude",
    primaryCandidates: ["Session"],
    weeklyCandidate: "Weekly",
    lines: [],
  },
]

const pluginSettings = { order: ["codex", "claude"], disabled: [] as string[] }

function makePluginStates(): Record<string, PluginState> {
  return {
    codex: {
      data: {
        providerId: "codex",
        displayName: "Codex",
        iconUrl: "icon-codex",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 40,
            limit: 100,
            format: { kind: "percent" },
          },
        ],
      },
      loading: false,
      error: null,
      lastManualRefreshAt: null,
      lastUpdatedAt: null,
    },
    claude: {
      data: {
        providerId: "claude",
        displayName: "Claude",
        iconUrl: "icon-claude",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 20,
            limit: 100,
            format: { kind: "percent" },
          },
          {
            type: "progress",
            label: "Weekly",
            used: 60,
            limit: 100,
            format: { kind: "percent" },
          },
        ],
      },
      loading: false,
      error: null,
      lastManualRefreshAt: null,
      lastUpdatedAt: null,
    },
  }
}

function defaultArgs(overrides: Partial<Parameters<typeof useTrayIcon>[0]> = {}) {
  return {
    dynamicTrayIconSettings: true,
    nativeTrayTitle: true,
    pluginsMeta,
    pluginSettings,
    pluginStates: makePluginStates(),
    displayMode: "used" as const,
    menubarIconStyle: "provider" as const,
    menubarMetric: "default" as const,
    activeView: "home",
    ...overrides,
  }
}

describe("useTrayIcon", () => {
  beforeEach(() => {
    trayMocks.getByIdMock.mockReset()
    trayMocks.setIconMock.mockReset()
    trayMocks.setIconAsTemplateMock.mockReset()
    trayMocks.setTitleMock.mockReset()
    trayMocks.setTooltipMock.mockReset()
    trayMocks.resolveResourceMock.mockReset()
    trayMocks.renderTrayBarsIconMock.mockReset()

    trayMocks.getByIdMock.mockResolvedValue({
      setIcon: trayMocks.setIconMock.mockResolvedValue(undefined),
      setIconAsTemplate: trayMocks.setIconAsTemplateMock.mockResolvedValue(undefined),
      setTitle: trayMocks.setTitleMock.mockResolvedValue(undefined),
      setTooltip: trayMocks.setTooltipMock.mockResolvedValue(undefined),
    })
    trayMocks.resolveResourceMock.mockResolvedValue("/resource/icons/tray-icon.png")
    trayMocks.renderTrayBarsIconMock.mockResolvedValue({})
  })

  it("skips tray initialization when dynamic tray settings are disabled", async () => {
    renderHook(() =>
      useTrayIcon(
        defaultArgs({
          dynamicTrayIconSettings: false,
        })
      )
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(trayMocks.getByIdMock).not.toHaveBeenCalled()
    expect(trayMocks.renderTrayBarsIconMock).not.toHaveBeenCalled()
  })

  it("keeps the last provider after leaving provider detail view", async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useTrayIcon>[0]) => useTrayIcon(props),
      {
        initialProps: defaultArgs({ activeView: "codex" }),
      }
    )

    await waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalled())
    const firstCall = trayMocks.renderTrayBarsIconMock.mock.calls.at(-1)?.[0]
    expect(firstCall?.bars?.[0]?.id).toBe("codex")

    trayMocks.renderTrayBarsIconMock.mockClear()
    rerender(defaultArgs({ activeView: "home" }))

    await waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalled())
    const stickyCall = trayMocks.renderTrayBarsIconMock.mock.calls.at(-1)?.[0]
    expect(stickyCall?.bars?.[0]?.id).toBe("codex")
  })

  it("prefers the active provider view over the sticky provider", async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useTrayIcon>[0]) => useTrayIcon(props),
      {
        initialProps: defaultArgs({ activeView: "codex" }),
      }
    )

    await waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalled())
    trayMocks.renderTrayBarsIconMock.mockClear()

    rerender(defaultArgs({ activeView: "claude" }))

    await waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalled())
    const activeCall = trayMocks.renderTrayBarsIconMock.mock.calls.at(-1)?.[0]
    expect(activeCall?.bars?.[0]?.id).toBe("claude")
  })

  it("passes preferWeekly when menubar metric is weekly", async () => {
    renderHook(() =>
      useTrayIcon(
        defaultArgs({
          activeView: "claude",
          menubarMetric: "weekly",
        })
      )
    )

    await waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalled())
    const call = trayMocks.renderTrayBarsIconMock.mock.calls.at(-1)?.[0]
    expect(call?.bars?.[0]?.weekly).toBe(true)
    expect(call?.bars?.[0]?.label).toBe("Weekly")
  })

  it("queues a follow-up tray update while a render is still in flight", async () => {
    vi.useFakeTimers()

    try {
      let resolveFirstRender: ((value: unknown) => void) | null = null
      const firstRender = new Promise<unknown>((resolve) => {
        resolveFirstRender = resolve
      })
      trayMocks.renderTrayBarsIconMock
        .mockReturnValueOnce(firstRender)
        .mockResolvedValue({})

      const { result } = renderHook(() => useTrayIcon(defaultArgs({ activeView: "codex" })))

      await vi.waitFor(() => expect(trayMocks.getByIdMock).toHaveBeenCalled())
      await vi.waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalledTimes(1))

      act(() => {
        result.current.scheduleTrayIconUpdate("probe", 0)
      })
      await vi.advanceTimersByTimeAsync(600)
      expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalledTimes(1)

      resolveFirstRender?.({})
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(trayMocks.renderTrayBarsIconMock).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })
})
