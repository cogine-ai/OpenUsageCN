import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
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
  it("waits for a nonblank required credential before submitting", async () => {
    render(<ProviderConfigFields pluginId="provider" fields={[{ ...secretField, required: true }]} onSaved={vi.fn()} />)
    const input = await screen.findByLabelText("API Key")
    const save = screen.getByRole("button", { name: "保存并检查" })
    expect(input).toHaveAttribute("aria-required", "true")
    expect(save).toBeDisabled()
    await userEvent.type(input, "   ")
    expect(save).toBeDisabled()
    await userEvent.type(input, "secret")
    expect(save).toBeEnabled()
  })

  it.each([
    { values: { apiKey: { type: "secret", configured: true } } },
    { values: {}, environment: { apiKey: { name: "API_KEY", configured: true } } },
  ])("allows checking a required credential already available from a safe source", async (initialView) => {
    render(<ProviderConfigFields pluginId="provider" fields={[{ ...secretField, required: true }]} initialView={initialView as import("@/lib/provider-config").ProviderConfigView} onSaved={vi.fn()} />)
    await screen.findByLabelText("API Key")
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeEnabled()
  })

  it("does not let a hidden saved credential satisfy the selected method", async () => {
    const fields: PluginConfigField[] = [
      { id: "source", type: "select", label: "Source", default: "api-key", options: [{ value: "api-key", label: "API Key Method" }, { value: "cookie", label: "Cookie Method" }] },
      { ...secretField, required: true, visibleWhen: { field: "source", values: ["api-key"] } },
      { id: "cookie", type: "secret", label: "Cookie", options: [], required: true, visibleWhen: { field: "source", values: ["cookie"] } },
    ]
    render(<ProviderConfigFields pluginId="provider" fields={fields} initialView={{ values: { cookie: { type: "secret", configured: true } } }} onSaved={vi.fn()} />)
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled()
    await userEvent.click(screen.getByRole("radio", { name: "Cookie Method" }))
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeEnabled()
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument()
  })

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
    expect(input).toHaveAttribute("placeholder", "已保存 ...abcd")
    expect(input).toHaveValue("")
    expect(screen.getByRole("button", { name: "清除 API Key" })).toBeInTheDocument()
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
    expect(input).toHaveAttribute("placeholder", "已保存")
    expect(input).toHaveValue("")
  })

  it("uses initial view without loading provider config again", async () => {
    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[secretField]}
        initialView={{
          values: {
            apiKey: { type: "secret", configured: true, hint: "...abcd" },
          },
        }}
        onSaved={vi.fn()}
      />
    )

    const input = await screen.findByLabelText("API Key")
    expect(input).toHaveAttribute("placeholder", "已保存 ...abcd")
    expect(providerConfigMocks.getProviderConfig).not.toHaveBeenCalled()
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
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))

    await waitFor(() => {
      expect(providerConfigMocks.saveProviderConfig).toHaveBeenCalledWith("bigmodel-cn", {
        apiKey: "new-secret-key",
      })
    })
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(2)
    expect(onSaved).toHaveBeenCalledWith("bigmodel-cn")
    expect(screen.getByText("连接成功")).toBeInTheDocument()
    expect(screen.getByLabelText("API Key")).toHaveValue("")
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "已保存 ...wxyz")
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

    await screen.findByRole("button", { name: "清除 API Key" })
    await userEvent.click(screen.getByRole("button", { name: "清除 API Key" }))

    await waitFor(() => {
      expect(providerConfigMocks.deleteProviderConfigField).toHaveBeenCalledWith(
        "bigmodel-cn",
        "apiKey"
      )
    })
    expect(onSaved).toHaveBeenCalledWith("bigmodel-cn")
    expect(screen.getByText("连接成功")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "清除 API Key" })).not.toBeInTheDocument()
  })

  it("reports a completed deletion separately from a rejected real connection check", async () => {
    const onSaved = vi.fn().mockRejectedValue(new Error("No provider API key found."))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.getProviderConfig
      .mockResolvedValueOnce({ values: { apiKey: { type: "secret", configured: true, hint: "...abcd" } } })
      .mockResolvedValueOnce({ values: { apiKey: { type: "secret", configured: false } } })
    render(<ProviderConfigFields pluginId="provider" fields={[secretField]} onSaved={onSaved} />)

    await userEvent.click(await screen.findByRole("button", { name: "清除 API Key" }))

    expect(await screen.findByText("已清除 · 缺少连接凭据")).toBeVisible()
    expect(providerConfigMocks.deleteProviderConfigField).toHaveBeenCalledWith("provider", "apiKey")
    expect(onSaved).toHaveBeenCalledWith("provider")
    expect(screen.queryByText("连接成功")).toBeNull()
    expect(screen.queryByText(/无法清除凭据/)).toBeNull()
    expect(screen.queryByRole("button", { name: "清除 API Key" })).toBeNull()
    expect(screen.getByLabelText("API Key")).toHaveValue("")
    errorSpy.mockRestore()
  })

  it("still verifies a deletion when it finishes after the form closes", async () => {
    let finishDelete!: () => void
    const deletion = new Promise<void>((resolve) => { finishDelete = resolve })
    const onSaved = vi.fn().mockResolvedValue(undefined)
    providerConfigMocks.deleteProviderConfigField.mockReturnValue(deletion)
    providerConfigMocks.getProviderConfig
      .mockResolvedValueOnce({ values: { apiKey: { type: "secret", configured: true } } })
      .mockResolvedValueOnce({ values: { apiKey: { type: "secret", configured: false } } })
    const { unmount } = render(<ProviderConfigFields pluginId="provider" fields={[secretField]} onSaved={onSaved} />)

    await userEvent.click(await screen.findByRole("button", { name: "清除 API Key" }))
    expect(onSaved).not.toHaveBeenCalled()
    unmount()
    await act(async () => { finishDelete(); await deletion })

    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith("provider"))
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(2)
  })

  it("still verifies persisted settings when saving finishes after the form closes", async () => {
    let finishSave!: () => void
    const persistence = new Promise<void>((resolve) => { finishSave = resolve })
    const onSaved = vi.fn().mockResolvedValue(undefined)
    providerConfigMocks.saveProviderConfig.mockReturnValue(persistence)
    const { unmount } = render(<ProviderConfigFields pluginId="provider" fields={[secretField]} onSaved={onSaved} />)

    await screen.findByLabelText("API Key")
    await userEvent.type(screen.getByLabelText("API Key"), "new-secret")
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))
    expect(providerConfigMocks.saveProviderConfig).toHaveBeenCalledWith("provider", { apiKey: "new-secret" })
    expect(onSaved).not.toHaveBeenCalled()
    unmount()
    await act(async () => { finishSave(); await persistence })

    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith("provider"))
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(2)
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

  it("blocks saving when configuration could not be loaded", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.getProviderConfig.mockRejectedValue(new Error("ipc unavailable"))

    render(
      <ProviderConfigFields
        pluginId="bigmodel-cn"
        fields={[toggleField]}
        onSaved={vi.fn()}
      />
    )

    expect(await screen.findByText("无法加载连接配置，请重试。")).toBeInTheDocument()
    expect(await screen.findByRole("checkbox", { name: "Enabled" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled()
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
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))

    expect(await screen.findByText("保存失败，请重试。")).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
  it("waits for the real check and never treats persistence as connection success", async () => {
    let finish!: () => void
    const onSaved = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<ProviderConfigFields pluginId="provider" fields={[secretField]} onSaved={onSaved} />)
    await screen.findByLabelText("API Key")
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))
    expect(await screen.findByText("已保存 · 正在检查连接")).toBeVisible()
    expect(screen.queryByText("连接成功")).toBeNull()
    expect(screen.getByRole("button", { name: "正在检查连接" })).toBeDisabled()
    finish()
    expect(await screen.findByText("连接成功")).toBeVisible()
  })

  it("keeps save success separate from a rejected connection check", async () => {
    const onSaved = vi.fn().mockRejectedValue(new Error("API key invalid"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<ProviderConfigFields pluginId="provider" fields={[secretField]} onSaved={onSaved} />)
    await screen.findByLabelText("API Key")
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))
    expect(await screen.findByText("已保存 · 登录凭据失效")).toBeVisible()
    expect(screen.queryByText("连接成功")).toBeNull()
    expect(screen.getByRole("button", { name: "重新检查已保存的连接" })).toBeEnabled()
    errorSpy.mockRestore()
  })

  it("only submits the selected method and does not erase the hidden Cookie", async () => {
    const source: PluginConfigField = { id: "source", type: "select", label: "Source", options: [{value:"api-key",label:"API Key"},{value:"manual-cookie",label:"Cookie"}], default:"api-key" }
    const api: PluginConfigField = { ...secretField, visibleWhen: {field:"source",values:["api-key"]} }
    const cookie: PluginConfigField = {id:"cookie",type:"secret",label:"Cookie",options:[],visibleWhen:{field:"source",values:["manual-cookie"]}}
    render(<ProviderConfigFields pluginId="provider" fields={[source, api, cookie]} onSaved={vi.fn().mockResolvedValue(undefined)} />)
    await screen.findByLabelText("API Key")
    expect(screen.queryByLabelText("Cookie")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))
    expect(providerConfigMocks.saveProviderConfig).toHaveBeenCalledWith("provider", {source:"api-key",apiKey:""})
  })

})
