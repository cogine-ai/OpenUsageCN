import { act, renderHook } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { ISOLATED_CONFIG_PROVIDERS, PROVIDER_CONFIG_CHANGED } from "@/lib/provider-config"
import { useProbeState } from "./use-probe-state"
import { useProbeEvents } from "@/hooks/use-probe-events"
import type { PluginOutput } from "@/lib/plugin-types"

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: any) => void>() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event, handler) => { mocks.listeners.set(event, handler); return () => mocks.listeners.delete(event) }) }))
const output = (providerId: string): PluginOutput => ({ providerId, displayName: providerId, iconUrl: "", lines: [{ type: "text", label: "Usage", value: "Old Account" }] })
const changed = (id: string) => window.dispatchEvent(new CustomEvent(PROVIDER_CONFIG_CHANGED, { detail: id }))
beforeEach(() => { mocks.listeners.clear(); mocks.invoke.mockReset(); mocks.invoke.mockImplementation(async (_, args) => ({ batchId: args.batchId, pluginIds: args.pluginIds })) })

it.each([...ISOLATED_CONFIG_PROVIDERS])("clears only %s quota, timestamps and loading, retaining its real error", (id) => {
  const { result } = renderHook(() => useProbeState({}))
  act(() => {
    result.current.handleProbeResult(output(id), { manual: true })
    result.current.handleProbeResult(output("codex"), { manual: true })
    result.current.setErrorForPlugins([id], "Previous Check Failed")
  })
  const unrelated = result.current.pluginStates.codex
  const errorAt = result.current.pluginStates[id].lastErrorAt
  act(() => changed(id))
  expect(result.current.pluginStates[id]).toMatchObject({ data: null, lastUpdatedAt: null, lastManualRefreshAt: null, loading: false, error: "Previous Check Failed", lastErrorAt: errorAt })
  expect(result.current.pluginStates.codex).toBe(unrelated)
})

it("leaves the original providers' config-event behavior unchanged", () => {
  const { result } = renderHook(() => useProbeState({}))
  act(() => result.current.handleProbeResult(output("codex"), { manual: true }))
  const previous = result.current.pluginStates.codex
  act(() => changed("codex"))
  expect(result.current.pluginStates.codex).toBe(previous)
})

it("rejects prior verification and ignores late old-source results while preserving other providers", async () => {
  const onResult = vi.fn(), onBatchComplete = vi.fn()
  const { result } = renderHook(() => useProbeEvents({ onResult, onBatchComplete }))
  let verification!: Promise<PluginOutput>
  await act(async () => { verification = result.current.verifyPlugin("muse"); await Promise.resolve() })
  const interrupted = expect(verification).rejects.toThrow("连接配置已更新")
  const oldBatch = mocks.invoke.mock.calls[0][1].batchId
  await act(async () => result.current.startBatch(["codex"]))
  const otherBatch = mocks.invoke.mock.calls[1][1].batchId
  act(() => changed("muse"))
  await interrupted
  act(() => {
    mocks.listeners.get("probe:result")?.({ payload: { batchId: oldBatch, output: output("muse") } })
    mocks.listeners.get("probe:result")?.({ payload: { batchId: otherBatch, output: output("codex") } })
  })
  expect(onResult).toHaveBeenCalledTimes(1)
  expect(onResult.mock.calls[0][0].providerId).toBe("codex")
  await act(async () => result.current.startBatch(["muse"]))
  const freshBatch = mocks.invoke.mock.calls[2][1].batchId
  act(() => mocks.listeners.get("probe:result")?.({ payload: { batchId: freshBatch, output: output("muse") } }))
  expect(onResult).toHaveBeenCalledTimes(2)
})
