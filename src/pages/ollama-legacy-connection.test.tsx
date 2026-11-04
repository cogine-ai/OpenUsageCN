import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginConfigField } from "@/lib/plugin-types"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { ProviderConnectionPage } from "./provider-connection"
import { useAppUiStore } from "@/stores/app-ui-store"

const fields: PluginConfigField[] = [
  { id: "apiKey", type: "secret", label: "API Key", required: true, options: [] },
]

describe("Ollama original connection validation", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockResolvedValue(vi.fn())
    useAppUiStore.getState().resetState()
    useAppUiStore.getState().openConnection("ollama", "config")
  })

  it.each(["legacy", "connection"])(
    "checks the original source explicitly while primary mode is %s",
    async (mode) => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      tauri.invoke.mockImplementation((command) => {
        if (command === "get_ollama_accounts")
          return Promise.resolve({
            revision: 1,
            legacy: { source: "apiKey", configured: true, revision: 0 },
            primary: { mode, ...(mode === "connection" ? { connectionId: "managed" } : {}) },
            connections: [],
          })
        if (command === "get_provider_config")
          return Promise.resolve({
            values: { apiKey: { type: "secret", configured: true, hint: "••••8F2A" } },
          })
        if (command === "save_provider_config") return Promise.resolve()
        if (command === "check_ollama_legacy_connection")
          return Promise.reject("Ollama API Key was rejected (HTTP 401).")
        throw new Error(`Unexpected IPC: ${command}`)
      })
      const onCheck = vi.fn(),
        onAccountChangeRefresh = vi.fn()
      render(
        <ProviderConnectionPage
          plugin={{ id: "ollama", name: "Ollama Cloud", enabled: true, config: { fields } }}
          onCheck={onCheck}
          onAccountChangeRefresh={onAccountChangeRefresh}
        />
      )
      await screen.findByText("账号连接")
      await userEvent.click(screen.getByRole("button", { name: "管理原有连接" }))
      const input = await screen.findByLabelText("API Key")
      await waitFor(() => expect(input).toBeEnabled())
      await userEvent.type(input, "synthetic-legacy-key")
      await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))
      await waitFor(() =>
        expect(tauri.invoke).toHaveBeenCalledWith("check_ollama_legacy_connection")
      )
      expect(await screen.findByRole("alert")).toBeInTheDocument()
      expect(screen.queryByText("连接成功")).not.toBeInTheDocument()
      expect(tauri.invoke).toHaveBeenCalledWith("save_provider_config", {
        pluginId: "ollama",
        values: { apiKey: "synthetic-legacy-key" },
      })
      expect(onCheck).not.toHaveBeenCalled()
      if (mode === "legacy") expect(onAccountChangeRefresh).toHaveBeenCalledOnce()
      else expect(onAccountChangeRefresh).not.toHaveBeenCalled()
    }
  )
})
