import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"
import type { PluginState } from "@/hooks/app/types"

const trayMock = vi.hoisted(() => ({
  setIcon: vi.fn(async () => undefined),
  setIconAsTemplate: vi.fn(async () => undefined),
  setTitle: vi.fn(async () => undefined),
  setTooltip: vi.fn(async () => undefined),
}))

const renderTrayBarsIconMock = vi.hoisted(() => vi.fn(async () => "rendered-icon"))
const getTrayPrimaryBarsMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: {
    getById: vi.fn(async () => trayMock),
  },
}))

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn(async () => "/gauge.png"),
}))

vi.mock("@/lib/tray-bars-icon", () => ({
  getTrayIconSizePx: vi.fn(() => 18),
  renderTrayBarsIcon: renderTrayBarsIconMock,
}))

vi.mock("@/lib/tray-primary-progress", () => ({
  getTrayPrimaryBars: getTrayPrimaryBarsMock,
}))

import { useTrayIcon } from "@/hooks/app/use-tray-icon"

const pluginSettings: PluginSettings = { order: ["codex", "claude"], disabled: [] }

function pluginMeta(id: string, iconUrl = `icon-${id}`): PluginMeta {
  return {
    id,
    name: id,
    iconUrl,
    primaryCandidates: ["Session"],
    lines: [],
  }
}

function pluginState(id: string, used: number, limit = 100): PluginState {
  return {
    data: {
      providerId: id,
      displayName: id,
      iconUrl: "",
      lines: [
        {
          type: "progress",
          label: "Session",
          used,
          limit,
          format: { kind: "percent" },
        },
      ],
    },
    loading: false,
    error: null,
  }
}

function baseArgs(overrides: Partial<Parameters<typeof useTrayIcon>[0]> = {}) {
  return {
    dynamicTrayIconSettings: true,
    nativeTrayTitle: true,
    pluginsMeta: [pluginMeta("codex"), pluginMeta("claude")],
    pluginSettings,
    pluginStates: {
      codex: pluginState("codex", 25),
      claude: pluginState("claude", 50),
    },
    displayMode: "used" as const,
    menubarIconStyle: "provider" as const,
    menubarMetric: "default" as const,
    activeView: "home",
    ...overrides,
  }
}

async function waitForTrayPreview(
  result: { current: ReturnType<typeof useTrayIcon> },
  predicate: () => boolean,
) {
  await waitFor(
    () => {
      predicate()
    },
    { timeout: 3000 },
  )
}

async function initializeTray(
  args: Parameters<typeof useTrayIcon>[0],
) {
  const hook = renderHook(() => useTrayIcon(args))
  await act(async () => {
    await Promise.resolve()
  })
  await waitForTrayPreview(hook.result, () =>
    hook.result.current.traySettingsPreview.providerBars.length > 0
    || hook.result.current.traySettingsPreview.bars.length > 0
    || args.pluginSettings?.disabled.length === args.pluginSettings?.order.length,
  )
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  return hook
}

describe("useTrayIcon", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    trayMock.setIcon.mockClear()
    trayMock.setIconAsTemplate.mockClear()
    trayMock.setTitle.mockClear()
    trayMock.setTooltip.mockClear()
    renderTrayBarsIconMock.mockClear()
    getTrayPrimaryBarsMock.mockReset()
    getTrayPrimaryBarsMock.mockImplementation(({ pluginId, maxBars }) => {
      const id = pluginId ?? (maxBars === 1 ? "codex" : "codex")
      const fraction = id === "claude" ? 0.5 : 0.75
      return [{ id, fraction, label: "Session" }]
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not initialize tray updates when dynamic tray settings are disabled", async () => {
    const { result } = renderHook(() =>
      useTrayIcon(baseArgs({ dynamicTrayIconSettings: false }))
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(result.current.traySettingsPreview).toEqual({
      bars: [],
      providerBars: [],
      providerPercentText: "--%",
    })
    expect(renderTrayBarsIconMock).not.toHaveBeenCalled()
  })

  it("prefers the active provider view for provider tray previews", async () => {
    const { result } = await initializeTray(baseArgs({ activeView: "claude" }))

    expect(getTrayPrimaryBarsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "claude", maxBars: 1 })
    )
    expect(result.current.traySettingsPreview.providerBars).toEqual([
      { id: "claude", fraction: 0.5, label: "Session" },
    ])
    expect(result.current.traySettingsPreview.providerIconUrl).toBe("icon-claude")
  })

  it("keeps the last provider after leaving a detail view", async () => {
    const { result, rerender } = renderHook(
      (activeView: string) => useTrayIcon(baseArgs({ activeView })),
      { initialProps: "claude" },
    )
    await act(async () => {
      await Promise.resolve()
    })
    await waitForTrayPreview(result, () => result.current.traySettingsPreview.providerBars[0]?.id === "claude")
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    rerender("home")
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(getTrayPrimaryBarsMock.mock.calls.some(([args]) =>
      args.pluginId === "claude" && args.maxBars === 1,
    )).toBe(true)
    expect(result.current.traySettingsPreview.providerBars[0]?.id).toBe("claude")
  })

  it("requests weekly metrics when the menubar metric is weekly", async () => {
    await initializeTray(baseArgs({ menubarMetric: "weekly" }))

    expect(getTrayPrimaryBarsMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferWeekly: true })
    )
  })

  it("coalesces overlapping tray updates into one follow-up render", async () => {
    let releaseRender!: () => void
    renderTrayBarsIconMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseRender = () => resolve("first-icon")
        })
    )
    renderTrayBarsIconMock.mockImplementation(async () => "second-icon")

    const { result } = await initializeTray(baseArgs())
    const initialCalls = renderTrayBarsIconMock.mock.calls.length

    act(() => {
      result.current.scheduleTrayIconUpdate("probe", 0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    releaseRender()
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(renderTrayBarsIconMock.mock.calls.length).toBeGreaterThan(initialCalls)
    expect(trayMock.setIcon).toHaveBeenCalled()
  })

  it("restores the gauge icon when no providers are enabled", async () => {
    await initializeTray(
      baseArgs({
        pluginSettings: { order: ["codex", "claude"], disabled: ["codex", "claude"] },
      }),
    )

    expect(trayMock.setIcon).toHaveBeenCalledWith("/gauge.png")
    expect(renderTrayBarsIconMock).not.toHaveBeenCalled()
  })
})
