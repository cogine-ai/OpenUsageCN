import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LOCAL_HTTP_API_BASE_URL,
  fetchLocalHttpApiHealth,
} from "@/lib/local-http-api"

describe("local-http-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fetches health from the local API base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        apiVersion: "v1",
        version: "0.6.29",
        service: {
          state: "running",
          bind: "127.0.0.1:6736",
          startedAt: "2026-06-16T10:00:00Z",
        },
        providers: { known: 18, enabled: 3, cached: 2 },
        cache: {
          ready: true,
          lastSuccessfulFetchAt: "2026-06-16T11:30:00Z",
        },
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLocalHttpApiHealth()).resolves.toMatchObject({
      status: "ok",
      cache: { ready: true },
    })
    expect(fetchMock).toHaveBeenCalledWith(`${LOCAL_HTTP_API_BASE_URL}/health`, {
      headers: { Accept: "application/json" },
    })
  })

  it("throws when health responds with a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      })
    )

    await expect(fetchLocalHttpApiHealth()).rejects.toThrow(
      "Local HTTP API health failed (503)"
    )
  })
})
