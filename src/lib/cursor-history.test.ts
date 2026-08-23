import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

describe("cursor history client", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
  })

  it("loads an account snapshot with camelCase arguments", async () => {
    tauri.invoke.mockResolvedValue(null)
    const { getCursorHistorySnapshot } = await import("./cursor-history")

    await expect(getCursorHistorySnapshot("cursor", "account-1")).resolves.toBeNull()
    expect(tauri.invoke).toHaveBeenCalledWith("get_cursor_history_snapshot", {
      providerId: "cursor",
      accountId: "account-1",
    })
  })

  it("refreshes an account snapshot with the supplied local time context", async () => {
    const result = { snapshot: null, stale: false }
    tauri.invoke.mockResolvedValue(result)
    const { refreshCursorHistory } = await import("./cursor-history")
    const input = {
      providerId: "cursor",
      accountId: "account-1",
      nowMs: 1_787_500_000_000,
      timeZone: "Asia/Taipei",
      utcOffsetSeconds: 28_800,
    }

    await expect(refreshCursorHistory(input)).resolves.toEqual(result)
    expect(tauri.invoke).toHaveBeenCalledWith("refresh_cursor_history", input)
  })
})
