import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
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

const selectField: PluginConfigField = {
  id: "region",
  type: "select",
  label: "Region",
  placeholder: undefined,
  help: undefined,
  options: [
    { value: "cn", label: "CN" },
    { value: "global", label: "Global" },
  ],
  default: "cn",
}

const toggleField: PluginConfigField = {
  id: "enabled",
  type: "toggle",
  label: "Enabled",
  placeholder: undefined,
  help: undefined,
  options: [],
  default: false,
}

describe("ProviderConfigFields", () => {
  beforeEach(() => {
    providerConfigMocks.getProviderConfig.mockReset()
    providerConfigMocks.saveProviderConfig.mockReset()
    providerConfigMocks.deleteProviderConfigField.mockReset()
    providerConfigMocks.getProviderConfig.mockResolvedValue({ values: {} })
    providerConfigMocks.saveProviderConfig.mockResolvedValue(undefined)
    providerConfigMocks.deleteProviderConfigField.mockResolvedValue(undefined)
  })

  it("loads saved values and shows configured secret hint", async () => {
    providerConfigMocks.getProviderConfig.mockResolvedValue({
      values: {
        apiKey: { type: "secret", configured: true, hint: "...cdef" },
        region: { type: "select", value: "global" },
        enabled: { type: "toggle", value: true },
      },
    })

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField, selectField, toggleField]}
        onSaved={vi.fn()}
      />
    )

    expect(await screen.findByLabelText("API Key")).toHaveAttribute("placeholder", "已配置 ...cdef")
    expect(screen.getByLabelText("Region")).toHaveValue("global")
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeChecked()
    expect(screen.getByRole("button", { name: "清除" })).toBeInTheDocument()
  })

  it("falls back to field defaults when no saved values exist", async () => {
    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField, selectField, toggleField]}
        onSaved={vi.fn()}
      />
    )

    expect(await screen.findByLabelText("API Key")).toHaveAttribute("placeholder", "key.secret")
    expect(screen.getByLabelText("Region")).toHaveValue("cn")
    expect(screen.getByRole("checkbox", { name: "Enabled" })).not.toBeChecked()
    expect(screen.queryByRole("button", { name: "清除" })).not.toBeInTheDocument()
  })

  it("saves draft values and notifies parent", async () => {
    const onSaved = vi.fn()
    providerConfigMocks.getProviderConfig
      .mockResolvedValueOnce({ values: {} })
      .mockResolvedValueOnce({
        values: {
          apiKey: { type: "secret", configured: true, hint: "...cdef" },
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
    expect(onSaved).toHaveBeenCalledWith("bigmodel-cn")
    expect(await screen.findByText("已保存，正在刷新")).toBeInTheDocument()
  })

  it("clears configured secret fields", async () => {
    const onSaved = vi.fn()
    providerConfigMocks.getProviderConfig
      .mockResolvedValueOnce({
        values: {
          apiKey: { type: "secret", configured: true, hint: "...cdef" },
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
    expect(await screen.findByText("已清除，正在刷新")).toBeInTheDocument()
  })

  it("shows load and save errors", async () => {
    providerConfigMocks.getProviderConfig.mockRejectedValueOnce(new Error("load failed"))
    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={vi.fn()}
      />
    )
    expect(await screen.findByText("无法加载配置")).toBeInTheDocument()

    providerConfigMocks.getProviderConfig.mockResolvedValue({ values: {} })
    providerConfigMocks.saveProviderConfig.mockRejectedValueOnce(new Error("save failed"))
    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        onSaved={vi.fn()}
      />
    )

    await userEvent.click((await screen.findAllByRole("button", { name: "保存" }))[1])
    expect(await screen.findByText("保存失败")).toBeInTheDocument()
  })
})
