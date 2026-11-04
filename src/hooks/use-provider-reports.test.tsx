import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PROVIDER_CONFIG_CHANGED } from "@/lib/provider-config"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { useProviderReports } from "./use-provider-reports"

function snapshot(providerId: string, requestId: string) {
  return { providerId, requestId, scopeKey: "a".repeat(64), fetchedAt: "2026-11-04T00:00:00Z", lines: [], reports: [] }
}

describe("on-demand provider reports", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("does not fetch until requested and sends camelCase scope parameters", async () => {
    tauri.invoke.mockImplementation((command, args) => Promise.resolve(command === "refresh_provider_reports" ? snapshot(args.providerId, args.requestId) : null))
    const { result } = renderHook(() => useProviderReports("codex"))
    expect(tauri.invoke).not.toHaveBeenCalled()
    await act(() => result.current.load())
    expect(tauri.invoke).toHaveBeenCalledWith("refresh_provider_reports", { providerId: "codex", requestId: expect.any(String) })
    expect(result.current.snapshot?.providerId).toBe("codex")
  })

  it("discards old responses after a source configuration change", async () => {
    let resolve: (value: unknown) => void = () => {}
    tauri.invoke.mockImplementation((command) => command === "refresh_provider_reports" ? new Promise((done) => { resolve = done }) : Promise.resolve(null))
    const { result } = renderHook(() => useProviderReports("ollama"))
    let loading: Promise<void> = Promise.resolve()
    act(() => { loading = result.current.load() })
    const args = tauri.invoke.mock.calls.find(([command]) => command === "refresh_provider_reports")![1]
    act(() => { window.dispatchEvent(new CustomEvent(PROVIDER_CONFIG_CHANGED, { detail: "ollama" })) })
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", args)
    await act(async () => { resolve(snapshot("ollama", args.requestId)); await loading })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("rejects a response for another request and reports a friendly failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockResolvedValue(snapshot("codex", "wrong-request"))
    const { result } = renderHook(() => useProviderReports("codex"))
    await act(() => result.current.load())
    expect(result.current.snapshot).toBeNull()
    expect(result.current.error).toContain("无法读取")
    expect(log).toHaveBeenCalledWith("Failed to load server reports")
  })

  it("cancels only the exact request on unmount and ignores its late response", async () => {
    let resolve: (value: unknown) => void = () => {}
    tauri.invoke.mockImplementation((command) => command === "refresh_provider_reports" ? new Promise((done) => { resolve = done }) : Promise.resolve(null))
    const { result, unmount } = renderHook(() => useProviderReports("openrouter"))
    let loading: Promise<void> = Promise.resolve()
    act(() => { loading = result.current.load() })
    const args = tauri.invoke.mock.calls[0][1]
    unmount()
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", args)
    await act(async () => { resolve(snapshot("openrouter", args.requestId)); await loading })
  })

  it("keeps only the newest requested result", async () => {
    const pending: { args: { providerId: string; requestId: string }; resolve: (value: unknown) => void }[] = []
    tauri.invoke.mockImplementation((command, args) => command === "refresh_provider_reports" ? new Promise((resolve) => pending.push({ args, resolve })) : Promise.resolve(null))
    const { result } = renderHook(() => useProviderReports("codex"))
    let first: Promise<void> = Promise.resolve(), next: Promise<void> = Promise.resolve()
    act(() => { first = result.current.load() })
    act(() => { next = result.current.load() })
    await act(async () => { pending[1].resolve(snapshot("codex", pending[1].args.requestId)); await next })
    await act(async () => { pending[0].resolve(snapshot("codex", pending[0].args.requestId)); await first })
    await waitFor(() => expect(result.current.snapshot?.requestId).toBe(pending[1].args.requestId))
  })
})
