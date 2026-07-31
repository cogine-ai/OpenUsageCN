import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"

const { listeners, invokeMock, listenMock } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

import {
  getProbeBatchStartFailedPluginIds,
  useProbeEvents,
} from "@/hooks/use-probe-events"

function stubRandomUUIDs(...batchIds: string[]) {
  const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID")
  for (const batchId of batchIds) {
    randomUUID.mockReturnValueOnce(
      batchId as `${string}-${string}-${string}-${string}-${string}`
    )
  }
  return () => randomUUID.mockRestore()
}

describe("useProbeEvents race handling", () => {
  beforeEach(() => {
    listeners.clear()
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockImplementation(
      async (event: string, callback: (event: { payload: any }) => void) => {
        listeners.set(event, callback)
        return () => listeners.delete(event)
      }
    )
  })

  it("does not restore a previous owner that already returned for the provider", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-failed")
    try {
      let rejectNew: (error: Error) => void = () => {}
      invokeMock
        .mockImplementationOnce(async (_cmd: string, args: any) => ({
          batchId: args.batchId,
          pluginIds: args.pluginIds,
        }))
        .mockImplementationOnce(
          () => new Promise((_resolve, reject) => {
            rejectNew = reject
          })
        )
      const onResult = vi.fn()
      const { result } = renderHook(() =>
        useProbeEvents({ onResult, onBatchComplete: vi.fn() })
      )

      await act(() => result.current.startBatch(["p", "q"]))
      const failurePromise = result.current
        .startBatch(["p"])
        .catch((error) => error)
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))

      const oldOutput = {
        providerId: "p",
        displayName: "Old P",
        lines: [],
        iconUrl: "",
      } satisfies PluginOutput
      listeners.get("probe:result")?.({
        payload: { batchId: "batch-old", output: oldOutput },
      })
      expect(onResult).not.toHaveBeenCalled()

      rejectNew(new Error("new failed"))
      const failure = await failurePromise
      expect(getProbeBatchStartFailedPluginIds(failure, [])).toEqual(["p"])
    } finally {
      restoreCrypto()
    }
  })

  it("registers overlapping batches with Tauri in caller order", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-new")
    try {
      let resolveOld: (
        value: { batchId: string; pluginIds: string[] }
      ) => void = () => {}
      invokeMock
        .mockImplementationOnce(
          () => new Promise<{ batchId: string; pluginIds: string[] }>((resolve) => {
            resolveOld = resolve
          })
        )
        .mockImplementationOnce(async (_cmd: string, args: any) => ({
          batchId: args.batchId,
          pluginIds: args.pluginIds,
        }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )

      const oldBatch = result.current.startBatch(["p"])
      const newBatch = result.current.startBatch(["p"])
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(invokeMock).toHaveBeenCalledTimes(1)

      resolveOld({ batchId: "batch-old", pluginIds: ["p"] })
      await oldBatch
      await newBatch

      expect(invokeMock.mock.calls.map(([, args]) => args.batchId)).toEqual([
        "batch-old",
        "batch-new",
      ])
    } finally {
      restoreCrypto()
    }
  })

  it("does not block an unrelated provider behind a pending start", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-p", "batch-q")
    try {
      let resolveP: (
        value: { batchId: string; pluginIds: string[] }
      ) => void = () => {}
      invokeMock
        .mockImplementationOnce(
          () => new Promise<{ batchId: string; pluginIds: string[] }>((resolve) => {
            resolveP = resolve
          })
        )
        .mockImplementationOnce(async (_cmd: string, args: any) => ({
          batchId: args.batchId,
          pluginIds: args.pluginIds,
        }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )

      const pendingP = result.current.startBatch(["p"])
      const startedQ = result.current.startBatch(["q"])
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))

      await expect(startedQ).resolves.toEqual(["q"])
      resolveP({ batchId: "batch-p", pluginIds: ["p"] })
      await expect(pendingP).resolves.toEqual(["p"])
    } finally {
      restoreCrypto()
    }
  })

  it("waits for every earlier provider before registering a combined batch", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-p", "batch-q", "batch-pq")
    try {
      const resolvers = new Map<
        string,
        (value: { batchId: string; pluginIds: string[] }) => void
      >()
      invokeMock.mockImplementation((_cmd: string, args: any) => {
        if (args.batchId === "batch-pq") {
          return Promise.resolve({
            batchId: args.batchId,
            pluginIds: args.pluginIds,
          })
        }
        return new Promise<{ batchId: string; pluginIds: string[] }>((resolve) => {
          resolvers.set(args.batchId, resolve)
        })
      })
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )

      const pendingP = result.current.startBatch(["p"])
      const pendingQ = result.current.startBatch(["q"])
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
      const combined = result.current.startBatch(["p", "q"])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(invokeMock).toHaveBeenCalledTimes(2)

      resolvers.get("batch-p")?.({ batchId: "batch-p", pluginIds: ["p"] })
      await pendingP
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(invokeMock).toHaveBeenCalledTimes(2)

      resolvers.get("batch-q")?.({ batchId: "batch-q", pluginIds: ["q"] })
      await pendingQ
      await expect(combined).resolves.toEqual(["p", "q"])
      expect(invokeMock).toHaveBeenCalledTimes(3)
    } finally {
      restoreCrypto()
    }
  })
})
