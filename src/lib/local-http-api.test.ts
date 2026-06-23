import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: state.invokeMock,
}))

describe("local HTTP API client", () => {
  beforeEach(() => {
    vi.resetModules()
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
    const { getLocalHttpApiStatus } = await import("./local-http-api")

    await expect(getLocalHttpApiStatus()).resolves.toEqual(status)
    expect(state.invokeMock).toHaveBeenCalledWith("get_local_http_api_status")
  })

  it("fetchLocalHttpApiHealth returns parsed health payload", async () => {
    const health = {
      status: "ok" as const,
      apiVersion: "v1" as const,
      version: "0.6.29",
      service: {
        state: "running" as const,
        bind: "127.0.0.1:6736",
        startedAt: "2026-06-16T10:00:00Z",
      },
      providers: { known: 2, enabled: 1, cached: 1 },
      cache: {
        ready: true,
        lastSuccessfulFetchAt: "2026-06-16T11:30:00Z",
      },
    }
    state.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => health,
    })
    const { fetchLocalHttpApiHealth, LOCAL_HTTP_API_BASE_URL } = await import("./local-http-api")

    await expect(fetchLocalHttpApiHealth()).resolves.toEqual(health)
    expect(state.fetchMock).toHaveBeenCalledWith(`${LOCAL_HTTP_API_BASE_URL}/health`, {
      headers: { Accept: "application/json" },
    })
  })

  it("fetchLocalHttpApiHealth throws when health request fails", async () => {
    state.fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    })
    const { fetchLocalHttpApiHealth } = await import("./local-http-api")

    await expect(fetchLocalHttpApiHealth()).rejects.toThrow(
      "Local HTTP API health failed (503)"
    )
  })
})
