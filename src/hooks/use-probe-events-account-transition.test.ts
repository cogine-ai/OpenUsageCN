import { act, renderHook } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: any }) => void>(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}))

import {
  getProbeBatchStartFailedPluginIds,
  useProbeEvents,
} from "@/hooks/use-probe-events"

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.listeners.clear()
  tauri.listen.mockImplementation(
    async (eventName: string, listener: (event: { payload: any }) => void) => {
      tauri.listeners.set(eventName, listener)
      return vi.fn()
    }
  )
})

it("keeps an account transition superseded when its batch fails to start", async () => {
  tauri.invoke
    .mockImplementationOnce(async (_command: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds,
    }))
    .mockRejectedValueOnce(new Error("boom"))
  const onResult = vi.fn()
  const { result } = renderHook(() =>
    useProbeEvents({ onResult, onBatchComplete: vi.fn() })
  )

  await act(() => result.current.startBatch(["p"]))
  const previousBatchId = tauri.invoke.mock.calls[0][1].batchId
  const failure = await result.current
    .startBatch(["p"], { invalidatePreviousOnFailure: true })
    .catch((error) => error)

  expect(getProbeBatchStartFailedPluginIds(failure, [])).toEqual(["p"])
  tauri.listeners.get("probe:result")?.({
    payload: {
      batchId: previousBatchId,
      output: {
        providerId: "p",
        displayName: "Old Account",
        lines: [],
        iconUrl: "",
      },
    },
  })
  expect(onResult).not.toHaveBeenCalled()
})
