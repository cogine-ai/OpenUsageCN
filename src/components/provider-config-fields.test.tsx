import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginConfigField } from "@/lib/plugin-types"

const providerConfigMocks = vi.hoisted(() => ({
  getProviderConfig: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfigField: vi.fn(),
}))

vi.mock("@/lib/provider-config", () => ({
  getProviderConfig: providerConfigMocks.getProviderConfig,
  saveProviderConfig: providerConfigMocks.saveProviderConfig,
  deleteProviderConfigField: providerConfigMocks.deleteProviderConfigField,
}))

import { ProviderConfigFields } from "@/components/provider-config-fields"

const secretField: PluginConfigField = {
  id: "apiKey",
  type: "secret",
  label: "API Key",
  placeholder: "key.secret",
  help: "留空则使用环境变量",
  options: [],
}

const toggleField: PluginConfigField = {
  id: "enabled",
  type: "toggle",
  label: "Enabled",
  options: [],
  default: true,
}

beforeEach(() => {
  providerConfigMocks.getProviderConfig.mockReset()
  providerConfigMocks.saveProviderConfig.mockReset()
  providerConfigMocks.deleteProviderConfigField.mockReset()
  providerConfigMocks.getProviderConfig.mockResolvedValue({ values: {} })
  providerConfigMocks.saveProviderConfig.mockResolvedValue(undefined)
  providerConfigMocks.deleteProviderConfigField.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("ProviderConfigFields", () => {
  it("shows configured secret placeholder without exposing the stored value", async () => {
    providerConfigMocks.getProviderConfig.mockResolvedValue({
      values: {
        apiKey: { type: "secret", configured: true, hint: "...abcd" },
      },
    })

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={vi.fn()}
      />
    )

    const input = await screen.findByLabelText("API Key")
    expect(input).toHaveAttribute("placeholder", "已配置 ...abcd")
    expect(input).toHaveValue("")
    expect(screen.getByRole("button", { name: "清除" })).toBeInTheDocument()
  })

  it("shows configured short secrets without duplicating the placeholder", async () => {
    providerConfigMocks.getProviderConfig.mockResolvedValue({
      values: {
        apiKey: { type: "secret", configured: true, hint: null },
      },
    })

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={vi.fn()}
      />
    )

    const input = await screen.findByLabelText("API Key")
    expect(input).toHaveAttribute("placeholder", "已配置")
    expect(input).toHaveValue("")
  })

  it("saves values and notifies parent after reload", async () => {
    const onSaved = vi.fn()
    providerConfigMocks.getProviderConfig
      .mockResolvedValueOnce({ values: {} })
      .mockResolvedValueOnce({
        values: {
          apiKey: { type: "secret", configured: true, hint: "...wxyz" },
        },
      })

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={onSaved}
      />
    )

    const input = await screen.findByLabelText("API Key")
    await userEvent.type(input, "new-secret-key")
    await userEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => {
      expect(providerConfigMocks.saveProviderConfig).toHaveBeenCalledWith("bigmodel-cn", {
        apiKey: "new-secret-key",
      })
    })
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(2)
    expect(onSaved).toHaveBeenCalledWith("bigmodel-cn")
    expect(screen.getByText("已保存，正在刷新")).toBeInTheDocument()
    expect(screen.getByLabelText("API Key")).toHaveValue("")
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "已配置 ...wxyz")
  })

  it("clears configured secrets and reloads the view", async () => {
    const onSaved = vi.fn()
    providerConfigMocks.getProviderConfig
      .mockResolvedValueOnce({
        values: {
          apiKey: { type: "secret", configured: true, hint: "...abcd" },
        },
      })
      .mockResolvedValueOnce({ values: {} })

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={onSaved}
      />
    )

    await screen.findByRole("button", { name: "清除" })
    await userEvent.click(screen.getByRole("button", { name: "清除" }))

    await waitFor(() => {
      expect(providerConfigMocks.deleteProviderConfigField).toHaveBeenCalledWith(
        "bigmodel-cn",
        "apiKey"
      )
    })
    expect(onSaved).toHaveBeenCalledWith("bigmodel-cn")
    expect(screen.getByText("已清除，正在刷新")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "清除" })).not.toBeInTheDocument()
  })

  it("initializes toggle fields from saved values and defaults", async () => {
    providerConfigMocks.getProviderConfig.mockResolvedValue({
      values: {
        enabled: { type: "toggle", value: false },
      },
    })

    render(
      <ProviderConfigFields
        pluginId="zai"
        fields={[toggleField]}
        onSaved={vi.fn()}
      />
    )

    const checkbox = await screen.findByRole("checkbox", { name: "Enabled" })
    expect(checkbox).not.toBeChecked()
  })

  it("shows load failure copy and still renders editable defaults", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.getProviderConfig.mockRejectedValue(new Error("ipc unavailable"))

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[toggleField]}
        onSaved={vi.fn()}
      />
    )

    expect(await screen.findByText("无法加载配置")).toBeInTheDocument()
    expect(await screen.findByRole("checkbox", { name: "Enabled" })).toBeChecked()
    consoleError.mockRestore()
  })

  it("shows clear failure copy without calling onSaved", async () => {
    const onSaved = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.getProviderConfig.mockResolvedValue({
      values: {
        apiKey: { type: "secret", configured: true, hint: "...abcd" },
      },
    })
    providerConfigMocks.deleteProviderConfigField.mockRejectedValue(
      new Error("damaged config")
    )

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={onSaved}
      />
    )

    await screen.findByRole("button", { name: "清除" })
    await userEvent.click(screen.getByRole("button", { name: "清除" }))

    expect(await screen.findByText("清除失败")).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it("shows save failure copy without calling onSaved", async () => {
    const onSaved = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.saveProviderConfig.mockRejectedValue(new Error("write failed"))

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={onSaved}
      />
    )

    await screen.findByLabelText("API Key")
    await userEvent.type(screen.getByLabelText("API Key"), "secret")
    await userEvent.click(screen.getByRole("button", { name: "保存" }))

    expect(await screen.findByText("保存失败")).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
