import { act, renderHook } from "@testing-library/react"
import { expect, it } from "vitest"
import { useProbeState } from "@/hooks/app/use-probe-state"
import type { PluginOutput } from "@/lib/plugin-types"

const success: PluginOutput = {
  providerId: "ollama", displayName: "Ollama Cloud", iconUrl: "",
  lines: [{ type: "text", label: "Monthly", value: "Account A quota" }],
}
const failure: PluginOutput = {
  ...success, lines: [{ type: "badge", label: "Error", text: "Connection changed" }],
}

it("clears Ollama home and tray data when the native credential scope is invalidated", () => {
  const { result } = renderHook(() => useProbeState({}))
  act(() => result.current.handleProbeResult(success, { manual: false }))
  act(() => result.current.handleProbeResult({ ...success, providerId: "codex" }, { manual: false }))
  act(() => result.current.handleProbeResult(failure, { manual: false, invalidateCachedData: true }))
  expect(result.current.pluginStates.ollama).toMatchObject({
    data: null, lastUpdatedAt: null, loading: false, error: "Connection changed",
  })
  expect(result.current.pluginStates.codex.data).not.toBeNull()
})

it("retains the last successful Ollama quota on an ordinary temporary failure", () => {
  const { result } = renderHook(() => useProbeState({}))
  act(() => result.current.handleProbeResult(success, { manual: false }))
  const updatedAt = result.current.pluginStates.ollama.lastUpdatedAt
  act(() => result.current.handleProbeResult(failure, { manual: false }))
  expect(result.current.pluginStates.ollama.data).toEqual(success)
  expect(result.current.pluginStates.ollama.lastUpdatedAt).toBe(updatedAt)
})

it("retains Ollama quota and its timestamp after a worker panic without invalidation", () => {
  const { result } = renderHook(() => useProbeState({}))
  act(() => result.current.handleProbeResult(success, { manual: false }))
  const updatedAt = result.current.pluginStates.ollama.lastUpdatedAt
  const crashed = { ...failure, lines: [{ type: "badge" as const, label: "Error", text: "Plugin crashed" }] }
  act(() => result.current.handleProbeResult(crashed, { manual: false }))
  expect(result.current.pluginStates.ollama).toMatchObject({
    data: success, lastUpdatedAt: updatedAt, loading: false, error: "Plugin crashed",
  })
})
