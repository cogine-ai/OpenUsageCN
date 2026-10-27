import { beforeEach, describe, expect, it, vi } from "vitest"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

import { recordedShortcut, setGlobalShortcutRecording, shortcutKeycaps } from "@/lib/global-shortcut"

describe("shortcutKeycaps", () => {
  it("maps modifier and special keys without changing registration tokens", () => {
    expect(shortcutKeycaps("CommandOrControl+Control+Alt+Shift+Return")).toEqual([
      "⌘",
      "⌃",
      "⌥",
      "⇧",
      "↵",
    ])
    expect(shortcutKeycaps("Numpad1")).toEqual(["Num1"])
  })
})

describe("recordedShortcut", () => {
  it("builds a persisted shortcut from physical key codes", () => {
    const result = recordedShortcut(new Set(["MetaLeft", "ControlLeft", "ShiftLeft", "KeyU"]))
    expect(result).toEqual({
      keys: ["⌘", "⌃", "⇧", "U"],
      invalid: false,
      shortcut: "Command+Control+Shift+U",
    })
  })

  it("marks multiple main keys as invalid", () => {
    const result = recordedShortcut(new Set(["MetaLeft", "KeyA", "KeyB"]))
    expect(result.invalid).toBe(true)
    expect(result.shortcut).toBeNull()
  })

  it("requires at least one modifier and one main key", () => {
    expect(recordedShortcut(new Set(["MetaLeft"])).shortcut).toBeNull()
    expect(recordedShortcut(new Set(["KeyU"])).shortcut).toBeNull()
  })
})

describe("setGlobalShortcutRecording", () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it("serializes recorder mute changes across IPC", async () => {
    const order: string[] = []
    invokeMock.mockImplementation(async (_cmd: string, args: { recording: boolean }) => {
      order.push(args.recording ? "on" : "off")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await Promise.all([
      setGlobalShortcutRecording(true),
      setGlobalShortcutRecording(false),
    ])

    expect(order).toEqual(["on", "off"])
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it("keeps later recorder changes ordered after a rejected request", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("ipc failed"))
      .mockResolvedValueOnce(undefined)

    await expect(setGlobalShortcutRecording(true)).rejects.toThrow("ipc failed")
    await expect(setGlobalShortcutRecording(false)).resolves.toBeUndefined()
    expect(invokeMock).toHaveBeenNthCalledWith(1, "set_global_shortcut_recording", { recording: true })
    expect(invokeMock).toHaveBeenNthCalledWith(2, "set_global_shortcut_recording", { recording: false })
  })
})
