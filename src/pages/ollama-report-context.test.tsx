import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import type { OllamaAccountsView } from "@/lib/ollama-accounts"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { PROVIDER_CONFIG_CHANGED } from "@/lib/provider-config"
import { useAppUiStore } from "@/stores/app-ui-store"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { ProviderDetailPage } from "./provider-detail"

function accounts(): OllamaAccountsView {
  const quota = (value: string) => ({
    providerId: "ollama",
    displayName: "Ollama Cloud",
    iconUrl: "",
    lines: [{ type: "text" as const, label: "Purchased Credits", value }],
  })
  return {
    revision: 1,
    primary: { mode: "connection", connectionId: "work" },
    legacy: {
      source: "apiKey",
      configured: true,
      revision: 1,
      snapshot: quota("$8.00"),
      lastUpdatedAt: "2026-11-05T01:00:00Z",
    },
    connections: [
      {
        connectionId: "work",
        label: "工作账号",
        identity: { name: "work" },
        keyHint: "ABCD",
        revision: 1,
        snapshot: quota("$12.00"),
        lastUpdatedAt: "2026-11-05T01:00:00Z",
      },
    ],
  }
}
const plugin: PluginDisplayState = {
  meta: { id: "ollama", name: "Ollama Cloud", iconUrl: "", lines: [] },
  data: {
    providerId: "ollama",
    displayName: "Ollama Cloud",
    iconUrl: "",
    lines: [{ type: "text", label: "Purchased Credits", value: "$999.00" }],
  },
  loading: false,
  error: null,
  lastManualRefreshAt: null,
  lastUpdatedAt: 1,
}
const page = () => (
  <ProviderDetailPage plugin={plugin} displayMode="used" resetTimerDisplayMode="relative" />
)
function report(args: Record<string, unknown>) {
  return {
    ...args,
    scopeKey: "a".repeat(64),
    fetchedAt: "2026-11-05T01:00:00Z",
    lines: [
      {
        type: "text",
        label: "7D Requests",
        value: args.useLegacy ? "Legacy Report" : "Work Report",
      },
    ],
    reports: [{ id: "7d", label: "7D Model Usage", status: "ready" }],
  }
}
let current: OllamaAccountsView
beforeEach(() => {
  current = accounts()
  useAppUiStore.getState().resetState()
  tauri.listen.mockReset().mockResolvedValue(vi.fn())
  tauri.invoke
    .mockReset()
    .mockImplementation((command, args) =>
      Promise.resolve(
        command === "get_ollama_accounts"
          ? current
          : command === "refresh_provider_reports"
            ? report(args)
            : current
      )
    )
})

it("uses original quota and an explicit original report context while a named account is primary", async () => {
  render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看原有连接用量" }))
  expect(screen.getByText("$8.00")).toBeVisible()
  expect(screen.queryByText("$999.00")).not.toBeInTheDocument()
  expect(screen.queryByText("$12.00")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
  await screen.findByText("Legacy Report")
  expect(tauri.invoke).toHaveBeenCalledWith("refresh_provider_reports", {
    providerId: "ollama",
    requestId: expect.any(String),
    useLegacy: true,
  })
  expect(tauri.invoke).not.toHaveBeenCalledWith(
    "perform_ollama_account_operation",
    expect.anything()
  )
})

it("explains Cookie report availability without requesting a primary account report", async () => {
  current.legacy.source = "cookie"
  render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看原有连接用量" }))
  expect(screen.getByText(/Cookie 连接不提供模型报告/)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Load Reports" })).not.toBeInTheDocument()
  expect(tauri.invoke).not.toHaveBeenCalledWith("refresh_provider_reports", expect.anything())
})

it("clears original reports on its own failed quota refresh without using another key", async () => {
  tauri.invoke.mockImplementation((command, args) => {
    if (command === "perform_ollama_account_operation")
      return Promise.resolve({
        ...current,
        revision: 2,
        legacy: {
          ...current.legacy,
          error: { code: "rateLimited", message: "原有连接暂时受限。" },
        },
      })
    return Promise.resolve(
      command === "get_ollama_accounts"
        ? current
        : command === "refresh_provider_reports"
          ? report(args)
          : null
    )
  })
  render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看原有连接用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
  await screen.findByText("Legacy Report")
  fireEvent.click(screen.getByRole("button", { name: "刷新当前账号" }))
  await screen.findByText("原有连接暂时受限。")
  expect(screen.queryByText("Legacy Report")).not.toBeInTheDocument()
  expect(screen.getByText("$8.00")).toBeVisible()
  expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
  expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", {
    operation: { kind: "refreshLegacy" },
  })
  expect(tauri.invoke.mock.calls.some(([command]) => command === "start_probe_batch")).toBe(false)
})

it("preserves a named report when only original configuration and quota change", async () => {
  render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看工作账号用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
  await screen.findByText("Work Report")
  current = {
    ...current,
    revision: 2,
    legacy: { ...current.legacy, revision: 2, snapshot: undefined, lastUpdatedAt: undefined },
  }
  const listener = tauri.listen.mock.calls.find(
    ([event]) => event === "ollama-accounts-changed"
  )![1]
  await act(async () => {
    window.dispatchEvent(new CustomEvent(PROVIDER_CONFIG_CHANGED, { detail: "ollama" }))
    listener({ payload: { revision: 2 } })
  })
  expect(screen.getByText("Work Report")).toBeVisible()
  expect(tauri.invoke).not.toHaveBeenCalledWith("cancel_provider_reports", expect.anything())
})

it("cancels an old key's pending report and rejects its late response after replacement", async () => {
  let finish: (value: unknown) => void = () => {}
  tauri.invoke.mockImplementation((command) =>
    command === "refresh_provider_reports"
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(command === "get_ollama_accounts" ? current : null)
  )
  render(page())
  fireEvent.click(await screen.findByRole("button", { name: "查看工作账号用量" }))
  fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
  const args = tauri.invoke.mock.calls.find(
    ([command]) => command === "refresh_provider_reports"
  )![1]
  current = {
    ...current,
    revision: 2,
    connections: [
      {
        ...current.connections[0],
        revision: 2,
        keyHint: "EFGH",
        snapshot: undefined,
        lastUpdatedAt: undefined,
      },
    ],
  }
  const listener = tauri.listen.mock.calls.find(
    ([event]) => event === "ollama-accounts-changed"
  )![1]
  await act(async () => listener({ payload: { revision: 2 } }))
  expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", {
    providerId: "ollama",
    requestId: args.requestId,
  })
  await act(async () => finish(report(args)))
  expect(screen.queryByText("Work Report")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
})
