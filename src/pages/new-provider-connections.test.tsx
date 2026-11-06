import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginConfigField } from "@/lib/plugin-types"
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { ProviderConnectionPage } from "@/pages/provider-connection"
import { useAppUiStore } from "@/stores/app-ui-store"

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.invoke.mockImplementation((command) => command === "get_provider_config" ? Promise.resolve({ values: {} }) : Promise.resolve())
  useAppUiStore.getState().resetState()
})

describe("New Provider Connection Routing", () => {
  it("uses Meta authorization even when native credentials are declared in the manifest", async () => {
    useAppUiStore.getState().openConnection("muse", "config", "accessToken")
    const fields: PluginConfigField[] = [{ id: "accessToken", type: "secret", label: "Access Token", options: [] }]
    render(<ProviderConnectionPage plugin={{ id: "muse", name: "Muse Code", enabled: false, config: { fields } }} onCheck={vi.fn()} onAccountChangeRefresh={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByRole("button", { name: "连接 Meta 账号" })).toBeVisible()
    expect(screen.queryByLabelText("Access Token")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "保存并检查" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "返回" }))
    expect(useAppUiStore.getState().connection).toBeNull()
  })
  it.each(["claude-platform", "workbuddy", "trae-cn", "litellm", "siliconflow"])("keeps %s on the existing masked configuration flow", async (id) => {
    useAppUiStore.getState().openConnection(id, "config")
    const fields: PluginConfigField[] = [{ id: "apiKey", type: "secret", label: "API Key", options: [], required: true }]
    render(<ProviderConnectionPage plugin={{ id, name: id, enabled: false, config: { fields } }} onCheck={vi.fn()} onAccountChangeRefresh={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password")
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "连接 Meta 账号" })).not.toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledWith("get_provider_config", { pluginId: id })
    expect(tauri.invoke).not.toHaveBeenCalledWith("start_muse_login")
  })
})
