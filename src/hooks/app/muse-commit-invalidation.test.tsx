import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"
import { useProbeState } from "./use-probe-state"
import { useProbeEvents } from "@/hooks/use-probe-events"
import { MuseConnection } from "@/components/muse-connection"

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
  invoke: vi.fn(), start: vi.fn(), poll: vi.fn(), cancel: vi.fn(), view: { values: {} } as any,
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event, callback) => { mocks.listeners.set(event, callback); return () => mocks.listeners.delete(event) }) }))
vi.mock("@/lib/muse-login", () => ({ startMuseLogin: mocks.start, pollMuseLogin: mocks.poll, cancelMuseLogin: mocks.cancel }))
const output = (value: string, providerId = "muse"): PluginOutput => ({ providerId, displayName: providerId, iconUrl: "", lines: [{ type: "text", label: "Usage", value }] })
const failure: PluginOutput = { ...output("unused"), lines: [{ type: "badge", label: "Error", text: "New Check Failed" }] }
const emit = (event: string, payload: any) => act(() => mocks.listeners.get(event)?.({ payload }))
const commit = (previousBatchId: string | null) => emit("provider:connection-committed", { providerId: "muse", previousBatchId })
function harness() {
  const onBatchComplete = vi.fn()
  return renderHook(() => {
    const state = useProbeState({})
    return { ...state, ...useProbeEvents({ onResult: state.handleProbeResult, onBatchComplete }) }
  })
}
type Probe = ReturnType<typeof harness>["result"]
async function start(probe: Probe, provider = "muse") {
  await act(async () => { probe.current.setLoadingForPlugins([provider]); await probe.current.startBatch([provider]) })
  return mocks.invoke.mock.calls.filter(([command]) => command === "start_probe_batch").at(-1)![1].batchId as string
}
function receive(batchId: string, result: PluginOutput) { emit("probe:result", { batchId, output: result }) }
function complete(batchId: string) { emit("probe:batch-complete", { batchId }) }
async function seed(probe: Probe, value = "Old Account", provider = "muse") {
  const id = await start(probe, provider); receive(id, output(value, provider)); complete(id); return id
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  mocks.listeners.clear(); mocks.invoke.mockReset(); mocks.start.mockReset(); mocks.poll.mockReset(); mocks.cancel.mockReset()
  mocks.view = { values: {} }
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_provider_config") return mocks.view
    if (command === "start_probe_batch") return { batchId: args.batchId, pluginIds: args.pluginIds }
    throw new Error("Unexpected synthetic IPC")
  })
  mocks.cancel.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it("clears completed old account data and actual freshness without changing other providers or errors", async () => {
  const { result } = harness()
  const old = await seed(result), other = await seed(result, "Other Provider", "codex")
  act(() => result.current.setErrorForPlugins(["muse"], "Existing Error"))
  const unrelated = result.current.pluginStates.codex
  commit(old)
  expect(result.current.pluginStates.muse).toMatchObject({ data: null, loading: false, error: "Existing Error", lastUpdatedAt: null, lastManualRefreshAt: null })
  expect(result.current.pluginStates.codex).toBe(unrelated)
  receive(old, output("Late Old Account")); complete(other)
  expect(result.current.pluginStates.muse.data).toBeNull()
})

it("interrupts an old pending verification but a new verification still completes", async () => {
  const { result } = harness()
  let verification!: Promise<PluginOutput>
  await act(async () => { result.current.setLoadingForPlugins(["muse"]); verification = result.current.verifyPlugin("muse"); await Promise.resolve() })
  const old = mocks.invoke.mock.calls[0][1].batchId
  const rejected = expect(verification).rejects.toThrow("连接配置已更新")
  commit(old); await rejected
  expect(result.current.pluginStates.muse.loading).toBe(false)
  receive(old, output("Ignored")); expect(result.current.pluginStates.muse.data).toBeNull()
  await act(async () => { verification = result.current.verifyPlugin("muse"); await Promise.resolve() })
  const fresh = mocks.invoke.mock.calls[1][1].batchId
  receive(fresh, output("Current Account"))
  await expect(verification).resolves.toEqual(output("Current Account"))
})

it.each(["pending", "failed"])("keeps new C success when the old commit arrives after D is %s", async (state) => {
  const { result } = harness(); const old = await seed(result)
  await seed(result, "Current Account")
  const freshData = result.current.pluginStates.muse.data, freshness = result.current.pluginStates.muse.lastUpdatedAt
  const newest = await start(result)
  if (state === "failed") receive(newest, failure)
  commit(old)
  expect(result.current.pluginStates.muse).toMatchObject({ data: freshData, lastUpdatedAt: freshness, loading: state === "pending", error: state === "failed" ? "New Check Failed" : null })
  if (state === "pending") receive(newest, output("Newest Account"))
  expect(result.current.pluginStates.muse.data).toEqual(state === "pending" ? output("Newest Account") : freshData)
})

it("keeps newer successful data and its error even if a still-newer batch failed to start", async () => {
  const { result } = harness(); const old = await seed(result)
  await seed(result, "New Source Success")
  mocks.invoke.mockRejectedValueOnce(new Error("New Start Failed"))
  await expect(result.current.startBatch(["muse"])).rejects.toThrow("New Start Failed")
  act(() => result.current.setErrorForPlugins(["muse"], "New Start Failed"))
  commit(old)
  expect(result.current.pluginStates.muse).toMatchObject({ data: output("New Source Success"), loading: false, error: "New Start Failed" })
})

it("retains the global commit listener while result callbacks are replaced", async () => {
  const onBatchComplete = vi.fn()
  const { result, rerender } = renderHook(({ notify }) => {
    const state = useProbeState({ onProbeResult: notify })
    return { ...state, ...useProbeEvents({ onResult: state.handleProbeResult, onBatchComplete }) }
  }, { initialProps: { notify: vi.fn() } })
  const old = await seed(result)
  const listener = mocks.listeners.get("provider:connection-committed")
  rerender({ notify: vi.fn() })
  commit(old)
  expect(result.current.pluginStates.muse.data).toBeNull()
  expect(mocks.listeners.get("provider:connection-committed")).toBe(listener)
  await act(async () => {})
})

it("clears old data but keeps loading for a newer claim whose native start has not returned", async () => {
  const { result } = harness(); const old = await seed(result)
  const pending = deferred<any>()
  mocks.invoke.mockReturnValueOnce(pending.promise)
  let starting!: Promise<string[]>
  await act(async () => { result.current.setLoadingForPlugins(["muse"]); starting = result.current.startBatch(["muse"]); await Promise.resolve() })
  const latestArgs = mocks.invoke.mock.calls.at(-1)![1]
  commit(old)
  expect(result.current.pluginStates.muse).toMatchObject({ data: null, lastUpdatedAt: null, loading: true })
  await act(async () => { pending.resolve({ batchId: latestArgs.batchId, pluginIds: ["muse"] }); await starting })
  receive(latestArgs.batchId, output("New Source"))
  expect(result.current.pluginStates.muse.data).toEqual(output("New Source"))
})

it("never restores an invalidated old owner after the newer native start fails", async () => {
  const { result } = harness(); const old = await start(result)
  const pending = deferred<any>(); mocks.invoke.mockReturnValueOnce(pending.promise)
  let starting!: Promise<string[]>
  await act(async () => { starting = result.current.startBatch(["muse"]); await Promise.resolve() })
  const rejected = expect(starting).rejects.toThrow("Start Failed")
  commit(old); pending.reject(new Error("Start Failed")); await rejected
  receive(old, output("Old Source Must Not Return"))
  expect(result.current.pluginStates.muse.data).toBeNull()
})

it("uses one real probe boundary for consecutive commits and protects a later successful probe", async () => {
  const { result } = harness(); const old = await seed(result)
  commit(old); commit(old)
  expect(result.current.pluginStates.muse.data).toBeNull()
  await seed(result, "Latest Source")
  commit(old); commit(old)
  expect(result.current.pluginStates.muse.data).toEqual(output("Latest Source"))
})

it.each([null, "previous-ui-session:9"])("clears only bootstrap data for a missing or foreign batch boundary: %s", async (boundary) => {
  const { result } = harness()
  await act(async () => {})
  act(() => result.current.handleProbeResult(output("Bootstrap"), { manual: false }))
  commit(boundary); expect(result.current.pluginStates.muse.data).toBeNull()
  await seed(result, "Current UI Success")
  commit(boundary); expect(result.current.pluginStates.muse.data).toEqual(output("Current UI Success"))
})

it.each(["cancel", "unmount"])("handles native commit after the authorization sheet %s without clearing a newer result", async (action) => {
  vi.useFakeTimers()
  const { result } = harness(); const old = await seed(result)
  const pending = deferred<any>()
  mocks.start.mockResolvedValue({ loginId: "synthetic-login", userCode: "TEST-1234", verificationUri: "https://auth.meta.com/device", expiresAt: Date.now() + 60000, intervalSeconds: 5 })
  mocks.poll.mockReturnValueOnce(pending.promise)
  const onSaved = vi.fn().mockResolvedValue(undefined)
  const sheet = render(<MuseConnection onBack={vi.fn()} onSaved={onSaved} />)
  await act(async () => {})
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "连接 Meta 账号", exact: true })))
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  if (action === "cancel") await act(async () => fireEvent.click(screen.getByRole("button", { name: "取消连接" })))
  else sheet.unmount()
  mocks.view = { values: { accessToken: { type: "secret", configured: true } } }
  await act(async () => { commit(old); await Promise.resolve() })
  expect(result.current.pluginStates.muse.data).toBeNull()
  if (action === "cancel") expect(screen.getByText("已保存 Meta 连接")).toBeVisible()
  await seed(result, "New Probe Already Succeeded")
  await act(async () => pending.resolve({ state: "succeeded" }))
  expect(onSaved).not.toHaveBeenCalled()
  expect(result.current.pluginStates.muse.data).toEqual(output("New Probe Already Succeeded"))
})
