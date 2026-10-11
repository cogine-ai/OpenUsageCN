import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const providerConfigMocks = vi.hoisted(() => ({ getProviderConfig: vi.fn() }))
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}))
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }))
vi.mock("@/lib/provider-config", () => ({ getProviderConfig: providerConfigMocks.getProviderConfig }))

import { SortablePluginItem, type SettingsPluginConfig } from "@/components/settings-plugin-item"
import { useAppUiStore } from "@/stores/app-ui-store"

const secretConfig: NonNullable<SettingsPluginConfig["config"]> = {
  fields: [{ id: "apiKey", type: "secret", label: "API Key", placeholder: "key.secret", help: "留空则使用环境变量", options: [], defaultSource: true }],
}
function renderItem(plugin: SettingsPluginConfig, onToggle = vi.fn()) {
  return render(<SortablePluginItem plugin={plugin} onToggle={onToggle} />)
}
beforeEach(() => {
  providerConfigMocks.getProviderConfig.mockReset().mockResolvedValue({ values: {} })
  useAppUiStore.getState().resetState()
})
afterEach(cleanup)

describe("SortablePluginItem", () => {
  it("opens local connection without toggling a provider that has no config or accounts", async () => {
    const onToggle = vi.fn()
    renderItem({ id: "codex", name: "Codex", enabled: false }, onToggle)
    await userEvent.click(screen.getByRole("button", { name: "连接 Codex" }))
    expect(useAppUiStore.getState().connection).toEqual({ providerId: "codex", kind: "local" })
    expect(onToggle).not.toHaveBeenCalled()
    expect(providerConfigMocks.getProviderConfig).not.toHaveBeenCalled()
  })

  it("routes config to the full-width connection page without embedding fields", async () => {
    renderItem({ id: "bigmodel-cn", name: "BigModel CN", enabled: true, config: secretConfig })
    expect(await screen.findByText("连接")).toBeInTheDocument()
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledWith("bigmodel-cn")
    await userEvent.click(screen.getByRole("button", { name: "连接 BigModel CN" }))
    expect(useAppUiStore.getState().connection).toEqual({ providerId: "bigmodel-cn", kind: "config" })
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument()
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(1)
  })

  it("routes account-capable providers to account management", async () => {
    renderItem({ id: "cursor", name: "Cursor", enabled: true, accountSupport: { localDiscovery: true, browserBinding: true, modelHistory: true } })
    await userEvent.click(screen.getByRole("button", { name: "连接 Cursor" }))
    expect(useAppUiStore.getState().connection).toEqual({ providerId: "cursor", kind: "accounts" })
  })

  it("keeps enabling independent from opening a connection", async () => {
    const onToggle = vi.fn()
    renderItem({ id: "bigmodel-cn", name: "BigModel CN", enabled: true, config: secretConfig }, onToggle)
    await userEvent.click(screen.getByRole("button", { name: "连接 BigModel CN" }))
    expect(onToggle).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("checkbox", { name: "停用 BigModel CN" }))
    expect(onToggle).toHaveBeenCalledWith("bigmodel-cn")
  })

  it("shows only saved or actually detected credentials without inferring detection from a manifest default", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.getProviderConfig.mockImplementation((id: string) => {
      if (id === "saved") return Promise.resolve({ values: { apiKey: { type: "secret", configured: true } } })
      if (id === "stored") return Promise.resolve({ values: { mode: { type: "select", value: "key" } }, storedFields: ["mode"] })
      if (id === "detected") return Promise.resolve({ values: {}, environment: { apiKey: { name: "TEST_API_KEY", configured: true } } })
      if (id === "failed") return Promise.reject(new Error("ipc unavailable"))
      return Promise.resolve({ values: {}, environment: { apiKey: { name: "TEST_API_KEY", configured: false } } })
    })
    for (const id of ["saved", "stored", "detected", "default", "failed"]) {
      renderItem({ id, name: id, enabled: true, config: secretConfig })
    }
    expect(await within(screen.getByRole("button", { name: "连接 saved" })).findByText("已保存")).toBeVisible()
    expect(await within(screen.getByRole("button", { name: "连接 stored" })).findByText("已保存")).toBeVisible()
    expect(await within(screen.getByRole("button", { name: "连接 detected" })).findByText("已发现凭据")).toBeVisible()
    expect(within(screen.getByRole("button", { name: "连接 default" })).getByText("连接")).toBeVisible()
    expect(await within(screen.getByRole("button", { name: "连接 failed" })).findByText("无法读取")).toBeVisible()
    expect(screen.queryByText("连接成功")).not.toBeInTheDocument()
    expect(screen.queryByText("使用默认")).not.toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
