import { renderHook, act, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"
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
  const originalCrypto = globalThis.crypto
  const randomUUID = vi.fn()
  for (const batchId of batchIds) randomUUID.mockReturnValueOnce(batchId)
  // @ts-expect-error the tests need only randomUUID from the Crypto interface
  globalThis.crypto = { randomUUID }
  return () => {
    globalThis.crypto = originalCrypto
  }
}

describe("useProbeEvents", () => {
  beforeEach(() => {
    listeners.clear()
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockImplementation(async (event: string, cb: (event: { payload: any }) => void) => {
      listeners.set(event, cb)
      return () => listeners.delete(event)
    })
  })

  it("starts batch and returns plugin ids", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    const ids = await act(() => result.current.startBatch(["a", "b"]))
    expect(invokeMock).toHaveBeenCalledWith("start_probe_batch", expect.objectContaining({ pluginIds: ["a", "b"] }))
    expect(ids).toEqual(["a", "b"])
  })

  it("uses fallback id when crypto is unavailable", async () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error test fallback path
    delete globalThis.crypto
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds ?? [],
      }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )
      const ids = await act(() => result.current.startBatch([]))
      expect(ids).toEqual([])
      expect(invokeMock).toHaveBeenCalledWith(
        "start_probe_batch",
        expect.objectContaining({ batchId: expect.stringMatching(/^batch-/) })
      )
    } finally {
      if (originalCrypto === undefined) {
        // @ts-expect-error cleanup undefined crypto
        delete globalThis.crypto
      } else {
        globalThis.crypto = originalCrypto
      }
    }
  })

  it("uses crypto randomUUID when available", async () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error test randomUUID path
    globalThis.crypto = { randomUUID: vi.fn(() => "uuid-123") }
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds ?? [],
      }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )
      await act(() => result.current.startBatch([]))
      expect(globalThis.crypto?.randomUUID).toHaveBeenCalled()
      expect(invokeMock).toHaveBeenCalledWith(
        "start_probe_batch",
        expect.objectContaining({ batchId: "uuid-123" })
      )
    } finally {
      globalThis.crypto = originalCrypto
    }
  })

  it("starts batch after unmount without waiting for listeners", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const { result, unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    const start = result.current.startBatch
    unmount()
    const ids = await act(() => start([]))
    expect(ids).toEqual([])
    expect(invokeMock).toHaveBeenCalled()
  })

  it("routes probe events to active batch", async () => {
    let lastArgs: any = null
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      lastArgs = args
      return { batchId: args.batchId, pluginIds: args.pluginIds ?? [] }
    })
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a"]))
    const batchId = lastArgs.batchId

    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    const resultListener = listeners.get("probe:result")
    const completeListener = listeners.get("probe:batch-complete")
    resultListener?.({ payload: { batchId, output } })
    expect(onResult).toHaveBeenCalledWith(output, { manual: false })

    completeListener?.({ payload: { batchId } })
    expect(onBatchComplete).toHaveBeenCalledTimes(1)

    resultListener?.({ payload: { batchId, output } })
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it("routes only the latest active batch for the same provider", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-new")
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds,
      }))
      const onResult = vi.fn()
      const { result } = renderHook(() =>
        useProbeEvents({ onResult, onBatchComplete: vi.fn() })
      )

      await act(() => result.current.startBatch(["a"], { manual: true }))
      await act(() => result.current.startBatch(["a"]))

      const oldOutput = {
        providerId: "a",
        displayName: "Old",
        lines: [],
        iconUrl: "",
      } satisfies PluginOutput
      const newOutput = {
        providerId: "a",
        displayName: "New",
        lines: [],
        iconUrl: "",
      } satisfies PluginOutput
      const resultListener = listeners.get("probe:result")

      resultListener?.({ payload: { batchId: "batch-old", output: oldOutput } })
      expect(onResult).not.toHaveBeenCalled()

      resultListener?.({ payload: { batchId: "batch-new", output: newOutput } })
      expect(onResult).toHaveBeenCalledWith(newOutput, { manual: false })
    } finally {
      restoreCrypto()
    }
  })

  it("keeps non-overlapping providers owned by an older batch", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-new")
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds,
      }))
      const onResult = vi.fn()
      const { result } = renderHook(() =>
        useProbeEvents({ onResult, onBatchComplete: vi.fn() })
      )

      await act(() => result.current.startBatch(["p", "q"]))
      await act(() => result.current.startBatch(["p"]))

      const resultListener = listeners.get("probe:result")
      const output = (providerId: string, displayName: string) => ({
        providerId,
        displayName,
        lines: [],
        iconUrl: "",
      }) satisfies PluginOutput

      resultListener?.({
        payload: { batchId: "batch-old", output: output("p", "Old P") },
      })
      resultListener?.({
        payload: { batchId: "batch-old", output: output("q", "Old Q") },
      })
      resultListener?.({
        payload: { batchId: "batch-new", output: output("p", "New P") },
      })

      expect(onResult).toHaveBeenNthCalledWith(
        1,
        output("q", "Old Q"),
        { manual: false }
      )
      expect(onResult).toHaveBeenNthCalledWith(
        2,
        output("p", "New P"),
        { manual: false }
      )
    } finally {
      restoreCrypto()
    }
  })

  it("claims provider ownership before awaiting listener readiness", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-new")
    try {
      invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
        batchId: args.batchId,
        pluginIds: args.pluginIds,
      }))
      const onResult = vi.fn()
      const { result } = renderHook(() =>
        useProbeEvents({ onResult, onBatchComplete: vi.fn() })
      )

      await act(() => result.current.startBatch(["a"]))
      const startNewBatch = result.current.startBatch(["a"])

      const oldOutput = {
        providerId: "a",
        displayName: "Old",
        lines: [],
        iconUrl: "",
      } satisfies PluginOutput
      listeners.get("probe:result")?.({
        payload: { batchId: "batch-old", output: oldOutput },
      })

      expect(onResult).not.toHaveBeenCalled()
      await act(() => startNewBatch)
    } finally {
      restoreCrypto()
    }
  })

  it("routes manual ownership with the accepted result", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds,
    }))
    const onResult = vi.fn()
    const { result } = renderHook(() =>
      useProbeEvents({ onResult, onBatchComplete: vi.fn() })
    )

    await act(() => result.current.startBatch(["a"], { manual: true }))
    const batchId = invokeMock.mock.calls[0][1].batchId
    const output = {
      providerId: "a",
      displayName: "A",
      lines: [],
      iconUrl: "",
    } satisfies PluginOutput

    listeners.get("probe:result")?.({ payload: { batchId, output } })

    expect(onResult).toHaveBeenCalledWith(output, { manual: true })
  })

  it("ignores events for inactive batch", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => ({
      batchId: args.batchId,
      pluginIds: args.pluginIds ?? [],
    }))
    const onResult = vi.fn()
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))

    await act(() => result.current.startBatch(["a"]))
    const output = { providerId: "a", displayName: "A", lines: [], iconUrl: "" } satisfies PluginOutput
    const resultListener = listeners.get("probe:result")
    const completeListener = listeners.get("probe:batch-complete")
    resultListener?.({ payload: { batchId: "other", output } })
    completeListener?.({ payload: { batchId: "other" } })

    expect(onResult).not.toHaveBeenCalled()
    expect(onBatchComplete).not.toHaveBeenCalled()
  })

  it("rejects when invoke fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )

    const failure = await result.current.startBatch(["a"]).catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty("message", "boom")
    expect(getProbeBatchStartFailedPluginIds(failure, [])).toEqual(["a"])
  })

  it("restores the previous active owner when a newer batch fails to start", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-failed")
    try {
      invokeMock
        .mockImplementationOnce(async (_cmd: string, args: any) => ({
          batchId: args.batchId,
          pluginIds: args.pluginIds,
        }))
        .mockRejectedValueOnce(new Error("boom"))
      const onResult = vi.fn()
      const { result } = renderHook(() =>
        useProbeEvents({ onResult, onBatchComplete: vi.fn() })
      )

      await act(() =>
        result.current.startBatch(["p", "q"], { manual: true })
      )
      const failure = await result.current.startBatch(["p"]).catch((error) => error)
      expect(failure).toHaveProperty("message", "boom")
      expect(getProbeBatchStartFailedPluginIds(failure, ["fallback"])).toEqual([])

      const output = (providerId: string) => ({
        providerId,
        displayName: providerId.toUpperCase(),
        lines: [],
        iconUrl: "",
      }) satisfies PluginOutput
      listeners.get("probe:result")?.({
        payload: { batchId: "batch-old", output: output("p") },
      })
      listeners.get("probe:result")?.({
        payload: { batchId: "batch-old", output: output("q") },
      })

      expect(onResult).toHaveBeenNthCalledWith(1, output("p"), { manual: true })
      expect(onResult).toHaveBeenNthCalledWith(2, output("q"), { manual: true })
    } finally {
      restoreCrypto()
    }
  })

  it("reports only providers still owned by a failed overlapping start", async () => {
    const restoreCrypto = stubRandomUUIDs("batch-old", "batch-new")
    try {
      let rejectOld: (error: Error) => void = () => {}
      invokeMock
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectOld = reject
        }))
        .mockImplementationOnce(async (_cmd: string, args: any) => ({
          batchId: args.batchId,
          pluginIds: args.pluginIds,
        }))
      const { result } = renderHook(() =>
        useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
      )

      const oldBatch = result.current.startBatch(["p", "q"])
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
      const newBatch = result.current.startBatch(["p"])
      const failurePromise = oldBatch.catch((error) => error)
      rejectOld(new Error("old failed"))
      const failure = await failurePromise
      await newBatch

      expect(getProbeBatchStartFailedPluginIds(failure, [])).toEqual(["q"])
    } finally {
      restoreCrypto()
    }
  })

  it("walks past multiple failed starts to the latest active owner", async () => {
    const restoreCrypto = stubRandomUUIDs(
      "batch-active",
      "batch-failed-b",
      "batch-failed-c"
    )
    try {
      let rejectB: (error: Error) => void = () => {}
      let rejectC: (error: Error) => void = () => {}
      invokeMock
        .mockImplementationOnce(async (_cmd: string, args: any) => ({
          batchId: args.batchId,
          pluginIds: args.pluginIds,
        }))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectB = reject
        }))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectC = reject
        }))
      const onResult = vi.fn()
      const { result } = renderHook(() =>
        useProbeEvents({ onResult, onBatchComplete: vi.fn() })
      )

      await act(() => result.current.startBatch(["p"]))
      const failedB = result.current.startBatch(["p"])
      const failedC = result.current.startBatch(["p"])
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))

      const rejectedB = expect(failedB).rejects.toThrow("b failed")
      rejectB(new Error("b failed"))
      await rejectedB
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3))
      const rejectedC = expect(failedC).rejects.toThrow("c failed")
      rejectC(new Error("c failed"))
      await rejectedC

      const output = {
        providerId: "p",
        displayName: "P",
        lines: [],
        iconUrl: "",
      } satisfies PluginOutput
      listeners.get("probe:result")?.({
        payload: { batchId: "batch-active", output },
      })

      expect(onResult).toHaveBeenCalledWith(output, { manual: false })
    } finally {
      restoreCrypto()
    }
  })

  it("cancels before listeners are ready", async () => {
    const unlisten = vi.fn()
    const ref: { resolve: ((val: () => void) => void) | null } = { resolve: null }
    listenMock.mockImplementationOnce(() => new Promise((resolve) => {
      ref.resolve = resolve
    }))
    const { unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    unmount()
    ref.resolve?.(unlisten)
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })

  it("cancels after first listener is ready", async () => {
    const unlistenFirst = vi.fn()
    const unlistenSecond = vi.fn()
    const ref: { resolve: ((val: () => void) => void) | null } = { resolve: null }
    listenMock
      .mockImplementationOnce(async () => unlistenFirst)
      .mockImplementationOnce(() => new Promise((resolve) => {
        ref.resolve = resolve
      }))
    const { unmount } = renderHook(() =>
      useProbeEvents({ onResult: vi.fn(), onBatchComplete: vi.fn() })
    )
    await Promise.resolve()
    unmount()
    ref.resolve?.(unlistenSecond)
    await Promise.resolve()
    expect(unlistenFirst).toHaveBeenCalled()
    expect(unlistenSecond).toHaveBeenCalled()
  })
})
