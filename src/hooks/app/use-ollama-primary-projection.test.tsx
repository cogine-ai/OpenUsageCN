import { act, renderHook, waitFor } from "@testing-library/react"
import { useCallback } from "react"
import { beforeEach, expect, it, vi } from "vitest"
import type { OllamaAccountsView } from "@/lib/ollama-accounts"
import { OLLAMA_ACCOUNTS_CHANGED } from "@/lib/ollama-accounts"
import { useProbeState } from "./use-probe-state"
import { useOllamaPrimaryProjection } from "./use-ollama-primary-projection"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), callbacks: new Map<string, () => void>() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))

function quota(label: string) {
  return { providerId: "ollama", displayName: "Ollama Cloud", iconUrl: "", lines: [{ type: "text" as const, label: "Account", value: label }] }
}
function view(primary: OllamaAccountsView["primary"] = { mode: "connection", connectionId: "home" }): OllamaAccountsView {
  return {
    revision: 1, primary,
    legacy: { configured: true, source: "cookie", revision: 1, snapshot: quota("Original"), lastUpdatedAt: "2026-11-05T00:00:00Z" },
    connections: ["home", "work"].map((id) => ({ connectionId: id, label: id, identity: { name: id }, keyHint: "1234", revision: 1, snapshot: quota(id), lastUpdatedAt: "2026-11-05T01:00:00Z" })),
  }
}
function useHarness(enabled = true) {
  const state = useProbeState({})
  const loading = useCallback(() => Boolean(state.pluginStatesRef.current.ollama?.loading), [state.pluginStatesRef])
  const { reload, invalidate } = useOllamaPrimaryProjection({ enabled, isLoading: loading, apply: state.syncOllamaProjection })
  return { ...state, reload, invalidate }
}
function changed() { tauri.callbacks.get(OLLAMA_ACCOUNTS_CHANGED)!() }

beforeEach(() => {
  tauri.invoke.mockReset().mockResolvedValue(view())
  tauri.callbacks.clear()
  tauri.listen.mockReset().mockImplementation(async (event, callback) => {
    tauri.callbacks.set(event, callback)
    return () => tauri.callbacks.delete(event)
  })
})

it("copies only the selected account's stored quota and success time to the tray without a new probe", async () => {
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.data).toEqual(quota("home")))
  expect(result.current.pluginStates.ollama.lastUpdatedAt).toBe(Date.parse("2026-11-05T01:00:00Z"))
  const next = view()
  next.connections[0].snapshot = quota("home updated")
  next.connections[0].lastUpdatedAt = "2026-11-05T01:05:00Z"
  tauri.invoke.mockResolvedValue(next)
  await act(async () => changed())
  expect(result.current.pluginStates.ollama).toMatchObject({ data: quota("home updated"), lastUpdatedAt: Date.parse("2026-11-05T01:05:00Z"), error: null })
  expect(tauri.invoke.mock.calls.every(([command]) => command === "get_ollama_accounts")).toBe(true)
})

it("keeps a failed primary's old quota/time and clears the error after a successful targeted update", async () => {
  const failed = view()
  failed.connections[0].error = { code: "network", message: "暂时无法连接" }
  tauri.invoke.mockResolvedValue(failed)
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.error).toBe("暂时无法连接"))
  expect(result.current.pluginStates.ollama).toMatchObject({ data: quota("home"), lastUpdatedAt: Date.parse("2026-11-05T01:00:00Z") })
  tauri.invoke.mockResolvedValue(view())
  await act(async () => changed())
  expect(result.current.pluginStates.ollama.error).toBeNull()
})

it.each(["legacy", "none"] as const)("never borrows named quota when primary is %s", async (mode) => {
  tauri.invoke.mockResolvedValue(view({ mode }))
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama).toBeDefined())
  expect(result.current.pluginStates.ollama.data).toEqual(mode === "legacy" ? quota("Original") : null)
  if (mode === "none") expect(result.current.pluginStates.ollama.error).toContain("尚未设置主账号")
})

it("rejects a late read from the previous selected account", async () => {
  let finish: (value: OllamaAccountsView) => void = () => {}
  tauri.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(tauri.callbacks.has(OLLAMA_ACCOUNTS_CHANGED)).toBe(true))
  tauri.invoke.mockResolvedValue(view({ mode: "connection", connectionId: "work" }))
  await act(async () => changed())
  expect(result.current.pluginStates.ollama.data).toEqual(quota("work"))
  await act(async () => finish(view()))
  expect(result.current.pluginStates.ollama.data).toEqual(quota("work"))
})

it("does not interrupt a global batch and restores actual freshness after completion", async () => {
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.data).toBeDefined())
  act(() => result.current.setLoadingForPlugins(["ollama"]))
  const calls = tauri.invoke.mock.calls.length
  await act(async () => changed())
  expect(tauri.invoke).toHaveBeenCalledTimes(calls)
  expect(result.current.pluginStates.ollama.loading).toBe(true)
  act(() => result.current.handleProbeResult(quota("generic batch"), { manual: true }))
  const manualAt = result.current.pluginStates.ollama.lastManualRefreshAt
  await act(async () => result.current.reload(true))
  expect(result.current.pluginStates.ollama).toMatchObject({ data: quota("home"), loading: false, lastManualRefreshAt: manualAt, lastUpdatedAt: Date.parse("2026-11-05T01:00:00Z") })
})

it("discards a read that arrives during a replacement batch", async () => {
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.data).toBeDefined())
  let finish: (value: OllamaAccountsView) => void = () => {}
  tauri.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  act(() => changed())
  act(() => result.current.setAccountTransitionForPlugins(["ollama"]))
  await act(async () => finish(view()))
  expect(result.current.pluginStates.ollama).toMatchObject({ data: null, loading: true })
})

it("keeps a primary worker error across unrelated account events until its own success", async () => {
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.data).toBeDefined())
  act(() => result.current.handleProbeResult({ ...quota("home"), lines: [{ type: "badge", label: "Error", text: "Plugin crashed" }] }, { manual: false }))
  await act(async () => result.current.reload(true))
  expect(result.current.pluginStates.ollama.error).toBe("Plugin crashed")
  const sibling = view()
  sibling.connections[1].label = "Renamed work"
  tauri.invoke.mockResolvedValue(sibling)
  await act(async () => changed())
  expect(result.current.pluginStates.ollama.error).toBe("Plugin crashed")
  sibling.connections[0].lastUpdatedAt = "2026-11-05T01:06:00Z"
  await act(async () => changed())
  expect(result.current.pluginStates.ollama.error).toBeNull()
})

it.each(["loading event", "batch start"])("rejects the old primary read after failed start using the %s fence", async (fence) => {
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.data).toBeDefined())
  let finish: (value: OllamaAccountsView) => void = () => {}
  tauri.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  act(() => changed())
  act(() => {
    if (fence === "batch start") result.current.invalidate()
    result.current.setAccountTransitionForPlugins(["ollama"])
    if (fence === "loading event") changed()
    result.current.setErrorForPlugins(["ollama"], "无法开始刷新")
  })
  await act(async () => finish(view()))
  expect(result.current.pluginStates.ollama).toMatchObject({ data: null, loading: false, error: "无法开始刷新" })
})

it("clears unreadable primary state with a friendly error and no raw exception logging", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const { result } = renderHook(() => useHarness())
  await waitFor(() => expect(result.current.pluginStates.ollama?.data).toBeDefined())
  tauri.invoke.mockRejectedValue(new Error("private raw credential"))
  await act(async () => changed())
  expect(result.current.pluginStates.ollama).toMatchObject({ data: null, lastUpdatedAt: null, error: "无法读取主账号用量，请重新读取账号状态。" })
  expect(log).toHaveBeenCalledWith("Failed to synchronize the Ollama primary projection")
  expect(JSON.stringify(log.mock.calls)).not.toContain("private raw credential")
  log.mockRestore()
})

it("does not read accounts while Ollama is disabled", async () => {
  renderHook(() => useHarness(false))
  await act(async () => {})
  expect(tauri.invoke).not.toHaveBeenCalled()
  expect(tauri.listen).not.toHaveBeenCalled()
})
