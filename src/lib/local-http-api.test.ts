import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: state.invokeMock,
}))

import {
  LOCAL_HTTP_API_BASE_URL,
  fetchLocalHttpApiHealth,
  getLocalHttpApiStatus,
} from "@/lib/local-http-api"

describe("local-http-api", () => {
  beforeEach(() => {
    state.invokeMock.mockReset()
    state.fetchMock.mockReset()
    vi.stubGlobal("fetch", state.fetchMock)
  })

  it("getLocalHttpApiStatus invokes the tauri command", async () => {
    const status = {
      state: "running" as const,
      bind: "127.0.0.1:6736",
      startedAt: "2026-06-16T10:00:00Z",
    }
    state.invokeMock.mockResolvedValue(status)

    await expect(getLocalHttpApiStatus()).resolves.toEqual(status)
    expect(state.invokeMock).toHaveBeenCalledWith("get_local_http_api_status")
  })

  it("fetchLocalHttpApiHealth requests the health endpoint", async () => {
    const health = {
      status: "ok" as const,
      apiVersion: "v1" as const,
      version: "0.6.29",
      service: {
        state: "running" as const,
        bind: "127.0.0.1:6736",
        startedAt: "2026-06-16T10:00:00Z",
      },
      providers: { known: 18, enabled: 3, cached: 2 },
      cache: {
        ready: true,
        lastSuccessfulFetchAt: "2026-06-16T11:30:00Z",
      },
    }
    state.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => health,
    })

    await expect(fetchLocalHttpApiHealth()).resolves.toEqual(health)
    expect(state.fetchMock).toHaveBeenCalledWith(
      `${LOCAL_HTTP_API_BASE_URL}/health`,
      { headers: { Accept: "application/json" } }
    )
  })

  it("fetchLocalHttpApiHealth throws when the response is not ok", async () => {
    state.fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    })

    await expect(fetchLocalHttpApiHealth()).rejects.toThrow(
      "Local HTTP API health failed (503)"
    )
  })
})
