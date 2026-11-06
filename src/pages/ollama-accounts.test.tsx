import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OllamaAccountsView } from "@/lib/ollama-accounts"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { OllamaAccountsPage } from "./ollama-accounts"

function accountView(): OllamaAccountsView {
  return {
    revision: 1,
    legacy: { source: "apiKey", configured: true, revision: 0 },
    primary: { mode: "connection", connectionId: "home" },
    connections: ["home", "work"].map((id) => ({
      connectionId: id,
      label: id === "home" ? "个人账号" : "工作账号",
      identity: { name: `@${id}` },
      keyHint: id === "home" ? "8F2A" : "91BC",
      revision: 1,
      lastUpdatedAt: "2026-11-04T01:00:00Z",
      plan: "Pro",
      snapshot: {
        providerId: "ollama",
        displayName: "Ollama Cloud",
        iconUrl: "",
        lines: [
          {
            type: "progress",
            label: "Monthly",
            used: id === "home" ? 24 : 68,
            limit: 100,
            format: { kind: "dollars" },
          },
        ],
      },
    })),
  }
}

function verified(differentAccount = false) {
  return {
    verificationId: "verified-token",
    identity: { name: differentAccount ? "@new-user" : "@home" },
    keyHint: "AABB",
    differentAccount,
    sameAccount: false,
  }
}

describe("Ollama multi-account management", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
    tauri.invoke.mockReset()
    tauri.listen.mockReset().mockResolvedValue(vi.fn())
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_ollama_accounts") return Promise.resolve(accountView())
      if (command === "verify_ollama_key") return Promise.resolve(verified())
      if (command === "save_ollama_key" || command === "perform_ollama_account_operation")
        return Promise.resolve({ ...accountView(), revision: 2 })
      if (command === "cancel_provider_reports") return Promise.resolve()
      throw new Error(`Unexpected IPC: ${command}`)
    })
  })

  it("requires fresh verification after a save token expires or persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const original = tauri.invoke.getMockImplementation()!
    tauri.invoke.mockImplementation((command, args) =>
      command === "save_ollama_key"
        ? Promise.reject(new Error("Verification expired"))
        : original(command, args)
    )
    render(<OllamaAccountsPage initialScreen="keys" />)
    await screen.findByText("个人账号", { exact: true })
    await userEvent.click(screen.getByRole("button", { name: "添加 Key", exact: true }))
    await userEvent.type(screen.getByLabelText("名称", { exact: true }), "New Account")
    await userEvent.type(screen.getByLabelText("API Key", { exact: true }), "synthetic-key")
    await userEvent.click(screen.getByRole("button", { name: "验证 Key", exact: true }))
    await screen.findByRole("button", { name: "确认添加", exact: true })
    await userEvent.click(screen.getByRole("button", { name: "确认添加", exact: true }))
    expect(await screen.findByText("未能保存连接，请重新输入并验证 Key。")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "确认添加", exact: true })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "验证 Key", exact: true })).toBeDisabled()
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveValue("")
  })

  it("shows independent account summaries and browsing never selects a primary", async () => {
    const onPrimaryChange = vi.fn()
    render(<OllamaAccountsPage onPrimaryChange={onPrimaryChange} />)
    await screen.findByRole("button", { name: "查看个人账号用量" })
    expect(screen.getByRole("article", { name: "个人账号用量" })).toHaveTextContent("24")
    expect(screen.getByRole("article", { name: "工作账号用量" })).toHaveTextContent("68")
    await userEvent.click(screen.getByRole("button", { name: "查看工作账号用量" }))
    expect(screen.getByRole("heading", { name: "工作账号" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "设为主账号" })).toBeEnabled()
    expect(onPrimaryChange).not.toHaveBeenCalled()
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      "perform_ollama_account_operation",
      expect.anything()
    )
    await userEvent.click(screen.getByRole("button", { name: "设为主账号" }))
    await waitFor(() => expect(onPrimaryChange).toHaveBeenCalledOnce())
    expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", {
      operation: { kind: "selectPrimary", connectionId: "work" },
    })
  })

  it("verifies a new key before saving and sends only its opaque verification token to save", async () => {
    const original = tauri.invoke.getMockImplementation()!
    tauri.invoke.mockImplementation((command, args) => command === "perform_ollama_account_operation"
      ? Promise.resolve({ ...accountView(), revision: 3, primary: { mode: "legacy" } })
      : original(command, args))
    render(<OllamaAccountsPage initialScreen="keys" />)
    await screen.findByText("账号连接")
    await userEvent.click(screen.getByRole("button", { name: "添加 Key" }))
    await userEvent.type(screen.getByRole("textbox", { name: "名称" }), "旅行")
    const key = screen.getByLabelText("API Key", { selector: "input" })
    await userEvent.type(key, "synthetic-new-key")
    expect(screen.queryByRole("button", { name: "确认添加" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "验证 Key" }))
    expect(await screen.findByRole("region", { name: "已验证账号" })).toHaveTextContent("@home")
    expect(key).toHaveValue("")
    expect(tauri.invoke).toHaveBeenCalledWith("verify_ollama_key", { apiKey: "synthetic-new-key" })
    await userEvent.click(screen.getByRole("button", { name: "确认添加" }))
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("save_ollama_key", {
        verificationId: "verified-token",
        label: "旅行",
        asNew: false,
      })
    )
    expect(await screen.findByText("已添加连接，主账号未改变。")).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "菜单栏 / API 默认账号" }), "legacy")
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("legacy"))
    expect(screen.getByRole("status")).toHaveTextContent("默认账号已改用原有连接。")
    expect(screen.queryByText("已添加连接，主账号未改变。")).not.toBeInTheDocument()
  })

  it("does not save or expose a key when verification fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockImplementation((command) =>
      command === "get_ollama_accounts"
        ? Promise.resolve(accountView())
        : Promise.reject(new Error("sensitive synthetic-new-key"))
    )
    render(<OllamaAccountsPage />)
    await userEvent.click(await screen.findByRole("button", { name: "查看个人账号用量" }))
    await userEvent.click(screen.getByRole("button", { name: "编辑当前连接" }))
    expect(screen.getByText(/当前连接 · ••••8F2A/)).toBeInTheDocument()
    await userEvent.type(
      screen.getByLabelText("API Key", { selector: "input" }),
      "synthetic-new-key"
    )
    await userEvent.click(screen.getByRole("button", { name: "验证 Key" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("原有连接保持不变")
    expect(screen.queryByText(/sensitive/)).not.toBeInTheDocument()
    expect(log).toHaveBeenCalledWith("Failed to verify Ollama API key")
    expect(tauri.invoke).not.toHaveBeenCalledWith("save_ollama_key", expect.anything())
  })

  it("adds another identity explicitly instead of replacing the old account", async () => {
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === "verify_ollama_key" ? verified(true) : accountView())
    )
    const onPrimaryChange = vi.fn()
    render(<OllamaAccountsPage onPrimaryChange={onPrimaryChange} />)
    await userEvent.click(await screen.findByRole("button", { name: "查看个人账号用量" }))
    await userEvent.click(screen.getByRole("button", { name: "编辑当前连接" }))
    await userEvent.type(screen.getByLabelText("API Key", { selector: "input" }), "other-user-key")
    await userEvent.click(screen.getByRole("button", { name: "验证 Key" }))
    expect(
      await screen.findByText("此 Key 属于另一个用户，将新增连接，原账号不替换。")
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "作为新账号添加" }))
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("save_ollama_key", {
        verificationId: "verified-token",
        label: "个人账号",
        asNew: true,
      })
    )
    expect(onPrimaryChange).not.toHaveBeenCalled()
  })

  it("drops verification after leaving the form and never saves the late result", async () => {
    let finish: (value: unknown) => void = () => {}
    tauri.invoke.mockImplementation((command) =>
      command === "verify_ollama_key"
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(accountView())
    )
    render(<OllamaAccountsPage initialScreen="keys" />)
    await screen.findByText("账号连接")
    await userEvent.click(screen.getByRole("button", { name: "添加 Key" }))
    await userEvent.type(screen.getByRole("textbox", { name: "名称" }), "新账号")
    await userEvent.type(screen.getByLabelText("API Key", { selector: "input" }), "synthetic-key")
    await userEvent.click(screen.getByRole("button", { name: "验证 Key" }))
    await userEvent.click(screen.getByRole("button", { name: "返回" }))
    await act(async () => {
      finish(verified())
    })
    expect(screen.queryByRole("region", { name: "已验证账号" })).not.toBeInTheDocument()
    expect(tauri.invoke).not.toHaveBeenCalledWith("save_ollama_key", expect.anything())
  })

  it("requires local removal confirmation and does not select a replacement primary", async () => {
    const next = {
      ...accountView(),
      revision: 2,
      primary: { mode: "none" as const },
      connections: [accountView().connections[1]],
    }
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === "perform_ollama_account_operation" ? next : accountView())
    )
    const onPrimaryChange = vi.fn()
    render(<OllamaAccountsPage initialScreen="keys" onPrimaryChange={onPrimaryChange} />)
    const menu = await screen.findByLabelText("个人账号连接操作")
    fireEvent.click(menu)
    await userEvent.click(within(menu.parentElement!).getByRole("button", { name: "移除连接" }))
    const confirmation = screen.getByRole("group", { name: "确认移除 个人账号" })
    expect(confirmation).toHaveTextContent("不会在 Ollama 撤销 Key")
    expect(confirmation).toHaveTextContent("不自动选择其他主账号")
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      "perform_ollama_account_operation",
      expect.anything()
    )
    await userEvent.click(within(confirmation).getByRole("button", { name: "从本机移除" }))
    await waitFor(() => expect(screen.getByRole("combobox", { name: "菜单栏 / API 默认账号" })).toHaveValue(""))
    expect(screen.getByRole("option", { name: "未设置" })).toHaveProperty("selected", true)
    expect(onPrimaryChange).toHaveBeenCalledOnce()
    expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", {
      operation: { kind: "remove", connectionId: "home" },
    })
  })

  it("keeps previous quota visible with a temporary failure without starting another global refresh", async () => {
    const next = accountView()
    next.connections[0].error = { code: "rateLimited", message: "请求过于频繁，请稍后重试。" }
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === "perform_ollama_account_operation" ? { ...next, revision: 2 } : accountView()
      )
    )
    const onPrimaryChange = vi.fn()
    render(<OllamaAccountsPage onPrimaryChange={onPrimaryChange} />)
    await userEvent.click(await screen.findByRole("button", { name: "查看个人账号用量" }))
    await userEvent.click(screen.getByRole("button", { name: "刷新当前账号" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("本次未更新")
    expect(screen.getByRole("region", { name: "账户额度" })).toHaveTextContent("24")
    expect(onPrimaryChange).not.toHaveBeenCalled()
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "perform_ollama_account_operation")).toHaveLength(1)
  })

  it("preserves original configuration and requires an explicit primary switch to use it", async () => {
    const onPrimaryChange = vi.fn()
    render(
      <OllamaAccountsPage
        initialScreen="keys"
        onPrimaryChange={onPrimaryChange}
        legacyConfiguration={<div>Existing Source Fields</div>}
      />
    )
    await screen.findByText("账号连接")
    await userEvent.click(screen.getByRole("button", { name: "管理原有连接" }))
    expect(screen.getByText("Existing Source Fields")).toBeInTheDocument()
    expect(tauri.invoke).not.toHaveBeenCalledWith("save_provider_config", expect.anything())
    await userEvent.click(screen.getByRole("button", { name: "将原有连接设为主账号" }))
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", {
        operation: { kind: "useLegacy" },
      })
    )
    expect(onPrimaryChange).toHaveBeenCalledOnce()
  })

  it("binds report requests to the viewed connection and drops an old account's late response", async () => {
    let finish: (value: unknown) => void = () => {}
    tauri.invoke.mockImplementation((command) =>
      command === "refresh_provider_reports"
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(command === "get_ollama_accounts" ? accountView() : undefined)
    )
    render(<OllamaAccountsPage />)
    await userEvent.click(await screen.findByRole("button", { name: "查看个人账号用量" }))
    await userEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    const pending = tauri.invoke.mock.calls.find(
      ([command]) => command === "refresh_provider_reports"
    )![1]
    expect(pending.connectionId).toBe("home")
    await userEvent.click(screen.getByRole("button", { name: "返回" }))
    await userEvent.click(screen.getByRole("button", { name: "查看工作账号用量" }))
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_provider_reports", {
      providerId: "ollama",
      requestId: pending.requestId,
    })
    await act(async () =>
      finish({
        providerId: "ollama",
        requestId: pending.requestId,
        scopeKey: "a".repeat(64),
        fetchedAt: "2026-11-04T00:00:00Z",
        lines: [{ type: "text", label: "7D Requests", value: "Home Only" }],
        reports: [{ id: "7d", label: "7D Model Usage", status: "ready" }],
      })
    )
    expect(screen.queryByText("Home Only")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    expect(tauri.invoke).toHaveBeenLastCalledWith("refresh_provider_reports", {
      providerId: "ollama",
      requestId: expect.any(String),
      connectionId: "work",
    })
  })

  it("never displays legacy quota when the managed primary was removed", async () => {
    tauri.invoke.mockResolvedValue({ revision: 3, primary: { mode: "none" }, connections: [], legacy: { source: "cookie", configured: false, revision: 0 } })
    render(<OllamaAccountsPage />)
    await userEvent.click(await screen.findByRole("button", { name: "管理账号" }))
    expect(await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })).toHaveValue("")
    expect(screen.queryByText("Old Legacy Quota")).not.toBeInTheDocument()
  })

  it("selects only the requested named default and leaves every connection intact", async () => {
    tauri.invoke.mockImplementation((command) => {
      if (command === "get_ollama_accounts") return Promise.resolve(accountView())
      if (command === "perform_ollama_account_operation") {
        return Promise.resolve({ ...accountView(), revision: 2, primary: { mode: "connection", connectionId: "work" } })
      }
      throw new Error(`Unexpected IPC: ${command}`)
    })
    const changed = vi.fn()
    render(<OllamaAccountsPage initialScreen="keys" onPrimaryChange={changed} />)
    const select = await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })
    expect(select).toHaveValue("connection:home")
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("get_ollama_accounts")
    await userEvent.selectOptions(select, "connection:work")
    await waitFor(() => expect(select).toHaveValue("connection:work"))
    expect(screen.getByText("个人账号", { exact: true })).toBeVisible()
    expect(screen.getByText("工作账号", { exact: true })).toBeVisible()
    expect(changed).toHaveBeenCalledOnce()
    expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", {
      operation: { kind: "selectPrimary", connectionId: "work" },
    })
  })

  it("requires explicit selection to use the original default connection", async () => {
    let finish!: (view: OllamaAccountsView) => void
    tauri.invoke.mockImplementation((command) => command === "get_ollama_accounts"
      ? Promise.resolve(accountView()) : new Promise((resolve) => { finish = resolve }))
    render(<OllamaAccountsPage initialScreen="keys" />)
    const select = await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })
    await userEvent.selectOptions(select, "legacy")
    expect(select).toBeDisabled()
    expect(select).toHaveValue("connection:home")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    await act(async () => { finish({ ...accountView(), revision: 2, primary: { mode: "legacy" } }) })
    await waitFor(() => expect(select).toHaveValue("legacy"))
    expect(screen.getByRole("status")).toHaveTextContent("默认账号已改用原有连接。")
    expect(tauri.invoke).toHaveBeenCalledWith("perform_ollama_account_operation", { operation: { kind: "useLegacy" } })
    expect(screen.getAllByRole("option")).toHaveLength(3)
  })

  it("keeps the confirmed default on failure and shows the owned error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockImplementation((command) => command === "get_ollama_accounts"
      ? Promise.resolve(accountView()) : Promise.reject("此连接已被移除，请重新选择。"))
    const changed = vi.fn()
    render(<OllamaAccountsPage initialScreen="keys" onPrimaryChange={changed} />)
    const select = await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })
    await userEvent.selectOptions(select, "connection:work")
    expect(await screen.findByRole("alert")).toHaveTextContent("此连接已被移除")
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue("connection:home")
    expect(changed).not.toHaveBeenCalled()
  })

  it("disables defaults whose credentials are unavailable without selecting a fallback", async () => {
    const view = accountView()
    view.primary = { mode: "none" }
    view.legacy.configured = false
    view.connections[1].error = { code: "identityChanged", message: "账号身份变化" }
    tauri.invoke.mockResolvedValue(view)
    render(<OllamaAccountsPage initialScreen="keys" />)
    expect(await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })).toHaveValue("")
    expect(screen.getByRole("option", { name: "工作账号 · @work" })).toBeDisabled()
    expect(screen.getByRole("option", { name: "原有连接 · 未配置" })).toBeDisabled()
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("get_ollama_accounts")
  })

  it("keeps the confirmed default and shows no success notice when switching to legacy fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockImplementation((command) => command === "get_ollama_accounts"
      ? Promise.resolve(accountView()) : Promise.reject("原有连接不可用，请检查配置。"))
    const changed = vi.fn()
    render(<OllamaAccountsPage initialScreen="keys" onPrimaryChange={changed} />)
    const select = await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })
    await userEvent.selectOptions(select, "legacy")
    expect(await screen.findByRole("alert")).toHaveTextContent("原有连接不可用")
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue("connection:home")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(changed).not.toHaveBeenCalled()
  })

  it.each([
    ["connection", "authExpired"], ["legacy", "authExpired"], ["legacy", "identityChanged"],
  ])("disables a configured %s default with %s without changing the primary", async (source, code) => {
    const view = accountView()
    const failed = source === "legacy" ? view.legacy : view.connections[1]
    failed.error = { code, message: "凭据不可用" }
    tauri.invoke.mockResolvedValue(view)
    render(<OllamaAccountsPage initialScreen="keys" />)
    expect(await screen.findByRole("combobox", { name: "菜单栏 / API 默认账号" })).toHaveValue("connection:home")
    expect(screen.getByRole("option", { name: source === "legacy" ? "原有连接" : "工作账号 · @work" })).toBeDisabled()
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("get_ollama_accounts")
  })
})
