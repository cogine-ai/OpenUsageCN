import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginConfigField } from "@/lib/plugin-types"

const mocks = vi.hoisted(() => ({ getProviderConfig: vi.fn(), saveProviderConfig: vi.fn(), deleteProviderConfigField: vi.fn() }))
vi.mock("@/lib/provider-config", () => mocks)
import { ProviderConfigFields } from "@/components/provider-config-fields"

const warning = "无法确认环境变量配置，请检查终端设置后重试。"
const key: PluginConfigField = { id: "apiKey", type: "secret", label: "API Key", required: true, options: [], environmentVariables: ["DEEPSEEK_API_KEY"] }
const regionFields: PluginConfigField[] = [
  { id: "region", type: "select", label: "Region", default: "auto", autoValue: "auto", options: [
    { value: "auto", label: "Auto" }, { value: "international", label: "International" }, { value: "china", label: "China" },
  ], environmentVariables: ["MOONSHOT_REGION"] },
  { ...key, id: "apiKeyIntl", label: "International API Key", environmentVariables: ["MOONSHOT_API_KEY"], visibleWhen: { field: "region", values: ["international"] } },
  { ...key, id: "apiKeyCn", label: "China API Key", environmentVariables: ["MOONSHOT_API_KEY"], visibleWhen: { field: "region", values: ["china"] } },
]

beforeEach(() => {
  mocks.getProviderConfig.mockReset()
  mocks.saveProviderConfig.mockReset().mockResolvedValue(undefined)
  mocks.deleteProviderConfigField.mockReset().mockResolvedValue(undefined)
})

describe("Provider Config Environment Sources", () => {
  it("keeps a confirmed source visible when another declared source is unconfirmed", async () => {
    const field = { ...key, environmentVariables: ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY"] }
    mocks.getProviderConfig.mockResolvedValue({ values: {}, environment: { apiKey: { name: "OPENAI_ADMIN_KEY", configured: true } },
      environmentError: warning, environmentUnresolved: ["OPENAI_API_KEY"] })
    render(<ProviderConfigFields pluginId="openai-api" fields={[field]} onSaved={vi.fn()} />)
    await screen.findByRole("alert")
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "高级设置" }))
    expect(screen.getByText("OPENAI_ADMIN_KEY")).toBeVisible()
    expect(screen.queryByText("环境来源未确认")).not.toBeInTheDocument()
  })

  it("keeps saved credentials editable and verifies them while displaying the lookup warning", async () => {
    mocks.getProviderConfig.mockResolvedValue({ values: { apiKey: { type: "secret", configured: true, hint: "...abcd" } },
      storedFields: ["apiKey"], environmentError: warning, environmentUnresolved: ["DEEPSEEK_API_KEY"] })
    const onSaved = vi.fn().mockResolvedValue(undefined)
    render(<ProviderConfigFields pluginId="deepseek" fields={[key]} onSaved={onSaved} />)
    expect(await screen.findByRole("alert")).toHaveTextContent(warning)
    expect(screen.getByLabelText("API Key")).toBeEnabled()
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "已保存 ...abcd")
    await userEvent.type(screen.getByLabelText("API Key"), "new-secret")
    await userEvent.click(screen.getByRole("button", { name: "保存并检查" }))
    expect(await screen.findByText("连接成功")).toBeVisible()
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("deepseek")
    expect(mocks.saveProviderConfig).toHaveBeenCalledWith("deepseek", { apiKey: "new-secret" })
    expect(screen.getByRole("alert")).toHaveTextContent(warning)
  })

  it("distinguishes an unknown environment source from a confirmed missing credential", async () => {
    mocks.getProviderConfig.mockResolvedValue({ values: {}, environmentError: warning, environmentUnresolved: ["DEEPSEEK_API_KEY"] })
    render(<ProviderConfigFields pluginId="deepseek" fields={[key]} onSaved={vi.fn()} />)
    await screen.findByRole("alert")
    expect(screen.getByLabelText("API Key")).toBeEnabled()
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "高级设置" }))
    expect(screen.getByText("环境来源未确认")).toBeVisible()
    expect(screen.queryByText("未发现凭据")).not.toBeInTheDocument()
  })

  it("requires an explicit region even when an international credential is saved", async () => {
    mocks.getProviderConfig.mockResolvedValue({ values: { region: { type: "select", value: "auto" }, apiKeyIntl: { type: "secret", configured: true } },
      environmentError: warning, environmentUnresolved: ["MOONSHOT_REGION"] })
    render(<ProviderConfigFields pluginId="moonshot" fields={regionFields} onSaved={vi.fn()} />)
    await screen.findByRole("alert")
    expect(screen.getByRole("radio", { name: "International" })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("radio", { name: "China" })).toHaveAttribute("aria-checked", "false")
    expect(screen.queryByLabelText("International API Key")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled()
    await userEvent.click(screen.getByRole("radio", { name: "International" }))
    expect(screen.getByLabelText("International API Key")).toBeEnabled()
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "高级设置" }))
    expect(screen.getByText("已保存")).toBeVisible()
    expect(screen.queryByText("环境来源未确认")).not.toBeInTheDocument()
  })

  it.each(["International", "China"])("keeps the %s key source unknown when its region was not confirmed", async (region) => {
    mocks.getProviderConfig.mockResolvedValue({ values: { region: { type: "select", value: "auto" } },
      environmentError: warning, environmentUnresolved: ["MOONSHOT_REGION"] })
    // Use a generic provider ID so the display rule depends on field metadata.
    render(<ProviderConfigFields pluginId="regional-provider" fields={regionFields} onSaved={vi.fn()} />)
    await screen.findByRole("alert")
    await userEvent.click(screen.getByRole("radio", { name: region }))
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled()
    expect(screen.getByLabelText(`${region} API Key`)).toHaveValue("")
    await userEvent.click(screen.getByRole("button", { name: "高级设置" }))
    expect(screen.getByText("环境来源未确认")).toBeVisible()
    expect(screen.queryByText("未发现凭据")).not.toBeInTheDocument()
  })

  it("does not invent an environment source for a field without one", async () => {
    mocks.getProviderConfig.mockResolvedValue({ values: { region: { type: "select", value: "international" } },
      environmentError: warning, environmentUnresolved: ["MOONSHOT_REGION"] })
    const fields = regionFields.map((field) => field.type === "secret" ? { ...field, environmentVariables: [] } : field)
    render(<ProviderConfigFields pluginId="regional-provider" fields={fields} onSaved={vi.fn()} />)
    await screen.findByRole("alert")
    await userEvent.click(screen.getByRole("button", { name: "高级设置" }))
    expect(screen.getByText("尚未检查外部来源")).toBeVisible()
    expect(screen.queryByText("环境来源未确认")).not.toBeInTheDocument()
  })
})
