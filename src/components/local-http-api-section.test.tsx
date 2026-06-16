import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const localApiMocks = vi.hoisted(() => ({
  getLocalHttpApiStatus: vi.fn(),
  fetchLocalHttpApiHealth: vi.fn(),
}))

vi.mock("@/lib/local-http-api", () => ({
  getLocalHttpApiStatus: localApiMocks.getLocalHttpApiStatus,
  fetchLocalHttpApiHealth: localApiMocks.fetchLocalHttpApiHealth,
  LOCAL_HTTP_API_BASE_URL: "http://127.0.0.1:6736",
}))

import { LocalHttpApiSection } from "@/components/local-http-api-section"

describe("LocalHttpApiSection", () => {
  beforeEach(() => {
    localApiMocks.getLocalHttpApiStatus.mockReset()
    localApiMocks.fetchLocalHttpApiHealth.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows separate running service and ready data states", async () => {
    localApiMocks.getLocalHttpApiStatus.mockResolvedValue({
      state: "running",
      bind: "127.0.0.1:6736",
      startedAt: "2026-06-16T10:00:00Z",
    })
    localApiMocks.fetchLocalHttpApiHealth.mockResolvedValue({
      status: "ok",
      apiVersion: "v1",
      version: "0.6.28",
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
    })

    render(<LocalHttpApiSection />)

    expect(screen.getByText("本地 API")).toBeInTheDocument()
    expect(await screen.findByText("运行中")).toBeInTheDocument()
    expect(await screen.findByText("已缓存 2 个服务商")).toBeInTheDocument()
    expect(localApiMocks.fetchLocalHttpApiHealth).toHaveBeenCalledTimes(1)
  })

  it("shows bind failures without fetching health", async () => {
    localApiMocks.getLocalHttpApiStatus.mockResolvedValue({
      state: "bind_failed",
      bind: "127.0.0.1:6736",
      error: "address already in use",
      failedAt: "2026-06-16T10:00:00Z",
    })

    render(<LocalHttpApiSection />)

    expect(await screen.findByText("端口不可用")).toBeInTheDocument()
    expect(screen.getByText("服务未运行")).toBeInTheDocument()
    expect(screen.getByText("address already in use")).toBeInTheDocument()
    await waitFor(() => {
      expect(localApiMocks.fetchLocalHttpApiHealth).not.toHaveBeenCalled()
    })
  })

  it("refreshes waiting data until cached data is ready", async () => {
    vi.useFakeTimers()
    localApiMocks.getLocalHttpApiStatus.mockResolvedValue({
      state: "running",
      bind: "127.0.0.1:6736",
      startedAt: "2026-06-16T10:00:00Z",
    })
    localApiMocks.fetchLocalHttpApiHealth
      .mockResolvedValueOnce({
        status: "ok",
        apiVersion: "v1",
        version: "0.6.28",
        service: {
          state: "running",
          bind: "127.0.0.1:6736",
          startedAt: "2026-06-16T10:00:00Z",
        },
        providers: { known: 18, enabled: 3, cached: 0 },
        cache: {
          ready: false,
          lastSuccessfulFetchAt: null,
        },
      })
      .mockResolvedValueOnce({
        status: "ok",
        apiVersion: "v1",
        version: "0.6.28",
        service: {
          state: "running",
          bind: "127.0.0.1:6736",
          startedAt: "2026-06-16T10:00:00Z",
        },
        providers: { known: 18, enabled: 3, cached: 1 },
        cache: {
          ready: true,
          lastSuccessfulFetchAt: "2026-06-16T11:30:00Z",
        },
      })

    render(<LocalHttpApiSection />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("等待首次刷新")).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(screen.getByText("已缓存 1 个服务商")).toBeInTheDocument()
    expect(localApiMocks.fetchLocalHttpApiHealth).toHaveBeenCalledTimes(2)
  })

  it("refreshes starting service status until the service is running", async () => {
    vi.useFakeTimers()
    localApiMocks.getLocalHttpApiStatus
      .mockResolvedValueOnce({
        state: "starting",
        bind: "127.0.0.1:6736",
      })
      .mockResolvedValueOnce({
        state: "running",
        bind: "127.0.0.1:6736",
        startedAt: "2026-06-16T10:00:00Z",
      })
    localApiMocks.fetchLocalHttpApiHealth.mockResolvedValue({
      status: "ok",
      apiVersion: "v1",
      version: "0.6.28",
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
    })

    render(<LocalHttpApiSection />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("启动中")).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(screen.getByText("运行中")).toBeInTheDocument()
    expect(screen.getByText("已缓存 2 个服务商")).toBeInTheDocument()
    expect(localApiMocks.getLocalHttpApiStatus).toHaveBeenCalledTimes(2)
    expect(localApiMocks.fetchLocalHttpApiHealth).toHaveBeenCalledTimes(1)
  })

  it("retries status polling after a transient status read failure", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    localApiMocks.getLocalHttpApiStatus
      .mockRejectedValueOnce(new Error("transient ipc failure"))
      .mockResolvedValueOnce({
        state: "running",
        bind: "127.0.0.1:6736",
        startedAt: "2026-06-16T10:00:00Z",
      })
    localApiMocks.fetchLocalHttpApiHealth.mockResolvedValue({
      status: "ok",
      apiVersion: "v1",
      version: "0.6.28",
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
    })

    render(<LocalHttpApiSection />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("无法读取服务状态")).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(screen.getByText("运行中")).toBeInTheDocument()
    expect(screen.getByText("已缓存 2 个服务商")).toBeInTheDocument()
    expect(localApiMocks.getLocalHttpApiStatus).toHaveBeenCalledTimes(2)
    expect(localApiMocks.fetchLocalHttpApiHealth).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
