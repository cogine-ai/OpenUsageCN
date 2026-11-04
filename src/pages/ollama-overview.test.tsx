import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import type { OllamaAccountsView } from "@/lib/ollama-accounts"
import type { PluginDisplayState } from "@/lib/plugin-types"
import { useAppUiStore } from "@/stores/app-ui-store"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { OverviewPage } from "./overview"

function accounts(configured = false): OllamaAccountsView {
  const snapshot = (value: string) => ({
    providerId: "ollama",
    displayName: "Ollama Cloud",
    iconUrl: "",
    lines: [{ type: "text" as const, label: "Purchased Credits", value }],
  })
  return {
    revision: 1,
    primary: { mode: "legacy" },
    legacy: {
      source: "cookie",
      configured,
      revision: 0,
      ...(configured ? { snapshot: snapshot("$8.00"), lastUpdatedAt: "2026-11-05T01:00:00Z" } : {}),
    },
    connections: ["home", "work"].map((id) => ({
      connectionId: id,
      label: id === "home" ? "个人账号" : "工作账号",
      identity: { name: `@${id}` },
      keyHint: "8F2A",
      revision: 1,
      snapshot: snapshot(id === "home" ? "$20.00" : "$12.00"),
      lastUpdatedAt: "2026-11-05T01:00:00Z",
    })),
  }
}
const plugin: PluginDisplayState = {
  meta: { id: "ollama", name: "Ollama Cloud", iconUrl: "", lines: [] },
  data: null,
  loading: false,
  error: "Missing Cookie header",
  lastManualRefreshAt: null,
  lastUpdatedAt: null,
}
function page() {
  return <OverviewPage plugins={[plugin]} displayMode="used" resetTimerDisplayMode="relative" />
}

beforeEach(() => {
  useAppUiStore.getState().resetState()
  tauri.invoke.mockReset().mockResolvedValue(accounts())
  tauri.listen.mockReset().mockResolvedValue(vi.fn())
})

it("shows both named account quotas when the original primary has no credential", async () => {
  render(page())
  await screen.findByRole("button", { name: "查看个人账号用量" })
  expect(screen.getByRole("button", { name: "查看工作账号用量" })).toBeVisible()
  expect(screen.getByText("$20.00")).toBeVisible()
  expect(screen.getByText("$12.00")).toBeVisible()
  expect(screen.queryByText("$32.00")).not.toBeInTheDocument()
  expect(screen.queryByText("缺少连接凭据")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "查看原有连接用量" })).not.toBeInTheDocument()
  expect(screen.getAllByRole("heading", { name: "Ollama Cloud", exact: true })).toHaveLength(1)
})

it("includes configured legacy usage beside named accounts independently of primary", async () => {
  tauri.invoke.mockResolvedValue({
    ...accounts(true),
    primary: { mode: "connection", connectionId: "work" },
  })
  render(page())
  await screen.findByRole("button", { name: "查看原有连接用量" })
  expect(screen.getByText("$8.00")).toBeVisible()
  expect(screen.getByText("$20.00")).toBeVisible()
  expect(screen.getByText("$12.00")).toBeVisible()
})

it("opens the exact account detail without changing the primary", async () => {
  const { ProviderDetailPage } = await import("./provider-detail")
  function Routes() {
    const activeView = useAppUiStore((state) => state.activeView)
    return activeView === "ollama" ? (
      <ProviderDetailPage plugin={plugin} displayMode="used" resetTimerDisplayMode="relative" />
    ) : (
      page()
    )
  }
  render(<Routes />)
  fireEvent.click(await screen.findByRole("button", { name: "查看工作账号用量" }))
  expect(await screen.findByRole("heading", { name: "工作账号", exact: true })).toBeVisible()
  expect(screen.getByText("$12.00")).toBeVisible()
  expect(screen.queryByText("$20.00")).not.toBeInTheDocument()
  expect(useAppUiStore.getState().ollamaAccount).toEqual({
    kind: "connection",
    connectionId: "work",
  })
  expect(tauri.invoke).not.toHaveBeenCalledWith(
    "perform_ollama_account_operation",
    expect.anything()
  )
  fireEvent.click(screen.getByRole("button", { name: "返回" }))
  await screen.findByRole("button", { name: "查看个人账号用量" })
  expect(screen.getByRole("button", { name: "查看工作账号用量" })).toBeVisible()
  expect(useAppUiStore.getState().ollamaAccount).toBeNull()
  expect(document.querySelector("button button")).toBeNull()
})

it("keeps every connection visible after changing the primary", async () => {
  let current = accounts(true)
  tauri.invoke.mockImplementation(() => Promise.resolve(current))
  render(page())
  await screen.findByRole("button", { name: "查看个人账号用量" })
  current = {
    ...current,
    revision: 2,
    primary: { mode: "connection", connectionId: "work" },
  }
  const listener = tauri.listen.mock.calls.find(
    ([event]) => event === "ollama-accounts-changed"
  )![1]
  await act(async () => listener({ payload: { revision: 2 } }))
  expect(
    within(screen.getByRole("article", { name: "工作账号用量" })).getByText("主账号")
  ).toBeVisible()
  expect(screen.getByText("$8.00")).toBeVisible()
  expect(screen.getByText("$20.00")).toBeVisible()
  expect(screen.getByText("$12.00")).toBeVisible()
})

it("shows one add-connection empty state when no connection has credentials", async () => {
  tauri.invoke.mockResolvedValue({ ...accounts(), connections: [] })
  render(page())
  await screen.findByRole("button", { name: "添加连接", exact: true })
  expect(screen.getAllByRole("button", { name: "添加连接", exact: true })).toHaveLength(1)
  expect(screen.queryByText("缺少连接凭据")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "刷新全部账号" })).toBeDisabled()
})

it("retains a failed connection's own data and timestamp beside a healthy account", async () => {
  const current = accounts()
  Object.assign(current.connections[1], {
    error: { code: "rateLimited", message: "工作账号暂时受限，请稍后重试。" },
  })
  tauri.invoke.mockResolvedValue(current)
  render(page())
  await screen.findByRole("button", { name: "查看工作账号用量" })
  const work = within(screen.getByRole("article", { name: "工作账号用量" }))
  expect(work.getByRole("alert")).toHaveTextContent("工作账号暂时受限")
  expect(work.getByText("$12.00")).toBeVisible()
  expect(work.getByText((_, node) => node?.tagName === "TIME")).toHaveAttribute(
    "datetime",
    "2026-11-05T01:00:00Z"
  )
  expect(
    within(screen.getByRole("article", { name: "个人账号用量" })).queryByRole("alert")
  ).not.toBeInTheDocument()
})

it("shows unresolved legacy settings as their own error rather than silently treating them as absent", async () => {
  const current = accounts()
  Object.assign(current.legacy, {
    error: { code: "configurationUnavailable", message: "原有连接的环境配置暂不可读。" },
  })
  tauri.invoke.mockResolvedValue(current)
  render(page())
  await screen.findByRole("button", { name: "查看原有连接用量" })
  expect(screen.getByText("原有连接的环境配置暂不可读。")).toBeVisible()
  expect(screen.getByText("$20.00")).toBeVisible()
  expect(screen.getByText("$12.00")).toBeVisible()
})

it("refreshes every connection once without starting another provider batch or selecting a primary", async () => {
  tauri.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "get_ollama_accounts" ? accounts(true) : { ...accounts(true), revision: 2 }
    )
  )
  render(page())
  const refresh = await screen.findByRole("button", { name: "刷新全部账号" })
  fireEvent.click(refresh)
  await screen.findByRole("button", { name: "查看原有连接用量" })
  expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", {
    operation: { kind: "refresh" },
  })
  expect(
    tauri.invoke.mock.calls.filter(([command]) => command === "perform_ollama_account_operation")
  ).toHaveLength(1)
  expect(tauri.invoke.mock.calls.some(([command]) => command === "start_probe_batch")).toBe(false)
})
