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

  it("refreshes an account snapshot with only account scope and IANA time zone", async () => {
    const result = { snapshot: null, stale: false }
    tauri.invoke.mockResolvedValue(result)
    const { refreshCursorHistory } = await import("./cursor-history")
    const input = {
      providerId: "cursor",
      accountId: "account-1",
      timeZone: "Asia/Taipei",
    }

    await expect(refreshCursorHistory(input)).resolves.toEqual(result)
    expect(tauri.invoke).toHaveBeenCalledWith("refresh_cursor_history", input)
  })

  it("lists recorded windows without requesting provider data", async () => {
    tauri.invoke.mockResolvedValue([])
    const { listCursorHistorySnapshots } = await import("./cursor-history")
    await expect(listCursorHistorySnapshots("cursor", "account-1")).resolves.toEqual([])
    expect(tauri.invoke).toHaveBeenCalledWith("list_cursor_history_snapshots", {
      providerId: "cursor", accountId: "account-1",
    })
  })

  it("exports only a stored window key with camelCase arguments", async () => {
    const { exportCursorHistoryCsv } = await import("./cursor-history")
    const { default: fixtures } = await import("@/components/__fixtures__/cursor-history.json")
    tauri.invoke.mockResolvedValue("/Downloads/cursor-history-123.csv")
    const history = fixtures[0] as import("./cursor-history").CompleteHistory
    await expect(exportCursorHistoryCsv("cursor", history.accountId, history)).resolves.toBe("/Downloads/cursor-history-123.csv")
    const { fromMs, toMs, fetchedAtMs } = history.coverage
    expect(tauri.invoke).toHaveBeenCalledWith("export_cursor_history_csv", {
      providerId: "cursor", accountId: history.accountId, snapshot: { fromMs, toMs, fetchedAtMs },
    })
  })
})
