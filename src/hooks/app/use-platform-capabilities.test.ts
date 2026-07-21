import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

import { usePlatformCapabilities } from "@/hooks/app/use-platform-capabilities"

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

describe("usePlatformCapabilities", () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it("loads capabilities from the backend", async () => {
    invokeMock.mockResolvedValue(windowsCapabilities)

    const { result } = renderHook(() => usePlatformCapabilities())

    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toEqual(windowsCapabilities))
    expect(invokeMock).toHaveBeenCalledWith("get_platform_capabilities")
  })

  it("logs a capability load failure and keeps platform features disabled", async () => {
    const error = new Error("capabilities unavailable")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock.mockRejectedValue(error)

    const { result } = renderHook(() => usePlatformCapabilities())

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("Failed to load platform capabilities:", error)
    })
    expect(result.current).toBeNull()
  })
})
