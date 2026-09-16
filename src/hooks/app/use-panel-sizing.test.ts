import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { currentMonitor, setSize } = vi.hoisted(() => ({
  currentMonitor: vi.fn(),
  setSize: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async () => undefined,
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}))
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor,
  getCurrentWindow: () => ({ setSize }),
  PhysicalSize: class {
    constructor(public width: number, public height: number) {}
  },
}))

import { usePanel } from "@/hooks/app/use-panel"

describe("panel sizing", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it.each([
    { label: "large Retina display", scale: 2, workHeight: 2100, content: 1800, cap: 720, height: 720 },
    { label: "small work area", scale: 1, workHeight: 620, content: 1800, cap: 588, height: 588 },
    { label: "small scaled work area", scale: 1.5, workHeight: 900, content: 1800, cap: 568, height: 568 },
    { label: "short content", scale: 2, workHeight: 2100, content: 340, cap: 720, height: 340 },
    { label: "missing monitor", scale: 2, workHeight: null, content: 1800, cap: 648, height: 648 },
  ])("sizes correctly for $label", async ({ scale, workHeight, content, cap, height }) => {
    setSize.mockResolvedValue(undefined)
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(scale)
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(680)
    currentMonitor.mockResolvedValue(workHeight === null ? null : {
      size: { height: workHeight + 200 },
      workArea: { size: { height: workHeight } },
    })

    const { result, rerender } = renderHook(() => usePanel({
      platform: "macos",
      activeView: "home",
      setActiveView: vi.fn(),
      showAbout: false,
      setShowAbout: vi.fn(),
      displayPlugins: [],
    }))
    act(() => {
      const container = document.createElement("div")
      Object.defineProperty(container, "scrollHeight", { value: content })
      result.current.containerRef.current = container
    })
    rerender()

    await waitFor(() => expect(result.current.maxPanelHeightPx).toBe(cap))
    expect(setSize).toHaveBeenLastCalledWith({ width: 400 * scale, height: height * scale })
  })

  it("updates the bottom fade when details expand or collapse in a fixed viewport", async () => {
    const { result, rerender } = renderHook(({ activeView }) => usePanel({
      platform: "macos",
      activeView,
      setActiveView: vi.fn(),
      showAbout: false,
      setShowAbout: vi.fn(),
      displayPlugins: [],
    }), { initialProps: { activeView: "home" } })
    const viewport = document.createElement("div")
    const details = document.createElement("details")
    viewport.append(details)
    Object.defineProperties(viewport, {
      clientHeight: { value: 500 },
      scrollHeight: { get: () => details.open ? 800 : 400 },
    })
    act(() => {
      result.current.scrollRef.current = viewport
    })
    rerender({ activeView: "cursor" })
    expect(result.current.canScrollDown).toBe(false)

    act(() => { details.open = true })
    await waitFor(() => expect(result.current.canScrollDown).toBe(true))

    act(() => { details.open = false })
    await waitFor(() => expect(result.current.canScrollDown).toBe(false))
  })
  it("updates the bottom fade when account management changes visibility", async () => {
    const { result, rerender } = renderHook(({ activeView }) => usePanel({
      platform: "macos", activeView, setActiveView: vi.fn(), showAbout: false,
      setShowAbout: vi.fn(), displayPlugins: [],
    }), { initialProps: { activeView: "home" } })
    const viewport = document.createElement("div")
    const accounts = document.createElement("div")
    accounts.hidden = true
    viewport.append(accounts)
    Object.defineProperties(viewport, {
      clientHeight: { value: 500 },
      scrollHeight: { get: () => accounts.hidden ? 400 : 800 },
    })
    act(() => { result.current.scrollRef.current = viewport })
    rerender({ activeView: "cursor" })
    expect(result.current.canScrollDown).toBe(false)
    act(() => { accounts.hidden = false })
    await waitFor(() => expect(result.current.canScrollDown).toBe(true))
    act(() => { accounts.hidden = true })
    await waitFor(() => expect(result.current.canScrollDown).toBe(false))
  })

})
