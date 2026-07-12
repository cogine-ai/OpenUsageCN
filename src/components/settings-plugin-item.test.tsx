import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const providerConfigMocks = vi.hoisted(() => ({
  getProviderConfig: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfigField: vi.fn(),
}))

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}))

vi.mock("@/lib/provider-config", () => ({
  getProviderConfig: providerConfigMocks.getProviderConfig,
  saveProviderConfig: providerConfigMocks.saveProviderConfig,
  deleteProviderConfigField: providerConfigMocks.deleteProviderConfigField,
}))

import { SortablePluginItem, type SettingsPluginConfig } from "@/components/settings-plugin-item"

const secretConfig: NonNullable<SettingsPluginConfig["config"]> = {
  fields: [
    {
      id: "apiKey",
      type: "secret",
      label: "API Key",
      placeholder: "key.secret",
      help: "留空则使用 BIGMODEL_API_KEY 或 ZHIPUAI_API_KEY 环境变量",
      options: [],
      defaultSource: true,
    },
  ],
}

function renderItem(
  plugin: SettingsPluginConfig,
  props?: Partial<Parameters<typeof SortablePluginItem>[0]>
) {
  return render(
    <SortablePluginItem
      plugin={plugin}
      onToggle={vi.fn()}
      onProviderConfigSaved={vi.fn()}
      {...props}
    />
  )
}

beforeEach(() => {
  providerConfigMocks.getProviderConfig.mockReset()
  providerConfigMocks.getProviderConfig.mockResolvedValue({ values: {} })
  providerConfigMocks.saveProviderConfig.mockReset()
  providerConfigMocks.saveProviderConfig.mockResolvedValue(undefined)
  providerConfigMocks.deleteProviderConfigField.mockReset()
  providerConfigMocks.deleteProviderConfigField.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("SortablePluginItem", () => {
  it("does not toggle providers when clicking a title without config fields", async () => {
    const onToggle = vi.fn()
    renderItem(
      { id: "beta", name: "Beta", enabled: false },
      { onToggle }
    )

    await userEvent.click(screen.getByText("Beta"))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("collapses provider config fields until the title is expanded", async () => {
    renderItem({
      id: "bigmodel-cn",
      name: "BigModel CN",
      enabled: true,
      config: secretConfig,
    })

    expect(await screen.findByText("使用默认")).toBeInTheDocument()
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "展开 BigModel CN 配置" }))
    expect(await screen.findByLabelText("API Key")).toBeInTheDocument()
    expect(providerConfigMocks.getProviderConfig).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("使用默认")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "收起 BigModel CN 配置" }))
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument()
    expect(await screen.findByText("使用默认")).toBeInTheDocument()
  })

  it("expands provider config titles without toggling the provider", async () => {
    const onToggle = vi.fn()
    renderItem(
      {
        id: "bigmodel-cn",
        name: "BigModel CN",
        enabled: true,
        config: secretConfig,
      },
      { onToggle }
    )

    await userEvent.click(screen.getByRole("button", { name: "展开 BigModel CN 配置" }))
    expect(onToggle).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("checkbox", { name: "停用 BigModel CN" }))
    expect(onToggle).toHaveBeenCalledWith("bigmodel-cn")
  })

  it("shows compact config status by provider config state", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    providerConfigMocks.getProviderConfig.mockImplementation((pluginId: string) => {
      if (pluginId === "stored") {
        return Promise.resolve({
          values: {
            apiKey: { type: "secret", configured: true, hint: "...abcd" },
          },
        })
      }
      if (pluginId === "failed") {
        return Promise.reject(new Error("ipc unavailable"))
      }
      return Promise.resolve({ values: {} })
    })

    render(
      <div>
        <SortablePluginItem
          plugin={{
            id: "stored",
            name: "Stored",
            enabled: true,
            config: {
              fields: [
                {
                  id: "apiKey",
                  type: "secret",
                  label: "API Key",
                  placeholder: "key.secret",
                  help: "留空则使用 STORED_API_KEY 环境变量",
                  options: [],
                },
              ],
            },
          }}
          onToggle={vi.fn()}
          onProviderConfigSaved={vi.fn()}
        />
        <SortablePluginItem
          plugin={{
            id: "default",
            name: "Default",
            enabled: true,
            config: {
              fields: [
                {
                  id: "apiKey",
                  type: "secret",
                  label: "API Key",
                  placeholder: "key.secret",
                  help: "留空则使用 DEFAULT_API_KEY 环境变量",
                  options: [],
                  defaultSource: true,
                },
              ],
            },
          }}
          onToggle={vi.fn()}
          onProviderConfigSaved={vi.fn()}
        />
        <SortablePluginItem
          plugin={{
            id: "empty",
            name: "Empty",
            enabled: true,
            config: {
              fields: [
                {
                  id: "apiKey",
                  type: "secret",
                  label: "API Key",
                  placeholder: "key.secret",
                  help: "必须填写 API Key",
                  options: [],
                },
              ],
            },
          }}
          onToggle={vi.fn()}
          onProviderConfigSaved={vi.fn()}
        />
        <SortablePluginItem
          plugin={{
            id: "failed",
            name: "Failed",
            enabled: true,
            config: {
              fields: [
                {
                  id: "apiKey",
                  type: "secret",
                  label: "API Key",
                  placeholder: "key.secret",
                  help: "留空则使用 FAILED_API_KEY 环境变量",
                  options: [],
                  defaultSource: true,
                },
              ],
            },
          }}
          onToggle={vi.fn()}
          onProviderConfigSaved={vi.fn()}
        />
      </div>
    )

    expect(await screen.findByText("已配置")).toBeInTheDocument()
    expect(await screen.findByText("使用默认")).toBeInTheDocument()
    expect(await screen.findByText("未配置")).toBeInTheDocument()
    expect(await screen.findByText("配置未知")).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it("shows configured status for select and toggle overrides", async () => {
    providerConfigMocks.getProviderConfig.mockImplementation((pluginId: string) => {
      if (pluginId === "select-override") {
        return Promise.resolve({
          values: {
            region: { type: "select", value: "global" },
          },
        })
      }
      if (pluginId === "toggle-override") {
        return Promise.resolve({
          values: {
            enabled: { type: "toggle", value: false },
          },
        })
      }
      return Promise.resolve({ values: {} })
    })

    render(
      <div>
        <SortablePluginItem
          plugin={{
            id: "select-override",
            name: "Select Override",
            enabled: true,
            config: {
              fields: [
                {
                  id: "region",
                  type: "select",
                  label: "Region",
                  options: [
                    { value: "cn", label: "CN" },
                    { value: "global", label: "Global" },
                  ],
                  default: "cn",
                  defaultSource: true,
                },
              ],
            },
          }}
          onToggle={vi.fn()}
          onProviderConfigSaved={vi.fn()}
        />
        <SortablePluginItem
          plugin={{
            id: "toggle-override",
            name: "Toggle Override",
            enabled: true,
            config: {
              fields: [
                {
                  id: "enabled",
                  type: "toggle",
                  label: "Enabled",
                  options: [],
                  default: true,
                  defaultSource: true,
                },
              ],
            },
          }}
          onToggle={vi.fn()}
          onProviderConfigSaved={vi.fn()}
        />
      </div>
    )

    const configuredBadges = await screen.findAllByText("已配置")
    expect(configuredBadges).toHaveLength(2)
    expect(screen.queryByText("使用默认")).not.toBeInTheDocument()
  })
})
