import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"

const { listeners, invokeMock, listenMock } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
import { useProbeEvents } from "@/hooks/use-probe-events"

const output = (providerId = "a", name = "Verified") => ({
  providerId, displayName: name, iconUrl: "", lines: [{ type: "progress", label: "Quota", used: 10, limit: 100, format: { kind: "percent" } }],
}) satisfies PluginOutput
const emitResult = (batchId: string, result: PluginOutput) => listeners.get("probe:result")!({ payload: { batchId, output: result } })
const emitComplete = (batchId: string) => listeners.get("probe:batch-complete")!({ payload: { batchId } })

function renderProbe() {
  const onResult = vi.fn()
  const onBatchComplete = vi.fn()
  return { ...renderHook(() => useProbeEvents({ onResult, onBatchComplete })), onResult, onBatchComplete }
}

describe("Provider Connection Verification", () => {
  beforeEach(() => {
    listeners.clear()
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockImplementation(async (name: string, listener: (event: { payload: any }) => void) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    })
    invokeMock.mockImplementation(async (_command: string, args: { batchId: string; pluginIds: string[] }) => ({ ...args }))
  })
  afterEach(() => vi.useRealTimers())

  it("accepts only its own current batch result for the requested provider", async () => {
    const { result, onResult } = renderProbe()
    await act(() => result.current.startBatch(["a"]))
    const previousBatch = invokeMock.mock.calls[0][1].batchId
    const verification = result.current.verifyPlugin("a")
    const resolved = vi.fn()
    const observed = verification.then(resolved)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    const ownBatch = invokeMock.mock.calls[1][1].batchId
    act(() => {
      emitResult(previousBatch, output("a", "Previous"))
      emitResult("unrelated-batch", output())
      emitResult(ownBatch, output("b", "Wrong Provider"))
    })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    expect(onResult).not.toHaveBeenCalled()
    act(() => emitResult(ownBatch, output()))
    await observed
    expect(resolved).toHaveBeenCalledWith(output())
    expect(onResult).toHaveBeenCalledWith(output(), { manual: true })
  })

  it("rejects a superseded verification and allows the replacement to succeed", async () => {
    const { result } = renderProbe()
    const previous = result.current.verifyPlugin("a")
    const rejection = expect(previous).rejects.toThrow("已开始新的检查")
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    const previousBatch = invokeMock.mock.calls[0][1].batchId
    const replacement = result.current.verifyPlugin("a")
    await rejection
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    const currentBatch = invokeMock.mock.calls[1][1].batchId
    act(() => { emitResult(previousBatch, output("a", "Superseded")); emitResult(currentBatch, output()) })
    await expect(replacement).resolves.toEqual(output())
  })

  it("does not treat batch completion without a provider result as successful verification", async () => {
    const { result } = renderProbe()
    const verification = result.current.verifyPlugin("a")
    const rejection = expect(verification).rejects.toThrow("检查未返回结果")
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    const batchId = invokeMock.mock.calls[0][1].batchId
    act(() => emitComplete(batchId))
    await rejection
    act(() => emitResult(batchId, output()))
    await expect(verification).rejects.toThrow("检查未返回结果")
  })

  it("rejects native start failures and cannot be rescued by a late result", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Native Start Failed"))
    const { result, onResult } = renderProbe()
    const verification = result.current.verifyPlugin("a")
    await expect(verification).rejects.toThrow("Native Start Failed")
    const batchId = invokeMock.mock.calls[0][1].batchId
    act(() => emitResult(batchId, output()))
    expect(onResult).not.toHaveBeenCalled()
    await expect(verification).rejects.toThrow("Native Start Failed")
  })

  it("rejects when the provider was not accepted into the native batch", async () => {
    invokeMock.mockImplementationOnce(async (_command: string, args: { batchId: string }) => ({ batchId: args.batchId, pluginIds: [] }))
    const { result } = renderProbe()
    await expect(result.current.verifyPlugin("a")).rejects.toThrow("服务商不可用")
  })

  it("keeps another provider's verification independent of a new batch", async () => {
    const { result } = renderProbe()
    const verification = result.current.verifyPlugin("a")
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    const ownBatch = invokeMock.mock.calls[0][1].batchId
    await act(() => result.current.startBatch(["b"]))
    act(() => emitResult(ownBatch, output()))
    await expect(verification).resolves.toEqual(output())
  })

  it("cancels a pending verification on unmount instead of marking the saved connection successful", async () => {
    const { result, unmount } = renderProbe()
    const verification = result.current.verifyPlugin("a")
    const rejection = expect(verification).rejects.toThrow("连接检查已取消")
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    unmount()
    await rejection
  })

  it("times out with a logged failure when the native batch never produces a result or completion", async () => {
    vi.useFakeTimers()
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderProbe()
    await act(async () => {})
    const verification = result.current.verifyPlugin("a")
    const rejection = expect(verification).rejects.toThrow("连接检查超时")
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    await rejection
    expect(errorLog).toHaveBeenCalledWith("Provider connection check timed out:", "a")
  })
})
