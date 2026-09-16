import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import type { ProviderAccountView } from "@/lib/plugin-types"
import { ProviderAccountControls } from "./provider-account-controls"
const view: ProviderAccountView = {
  providerId: "cursor", selection: { mode: "auto" }, activeAccountId: "a",
  accounts: [{ accountId: "a", label: "Work", connectionKinds: ["chrome"],
    connections: [{ connectionId: "c", kind: "chrome", available: true, profileKey: "Default" }], selected: true, stale: false }],
}
const receipt = (next = view, status = "succeeded") => ({ operationId: "op", status, sourceOutcomes: [], view: next })
describe("Account Management", () => {
  beforeEach(() => { tauri.invoke.mockReset(); tauri.listen.mockResolvedValue(vi.fn()) })
  it("starts collapsed with account identity and preserves expansion after refresh", async () => {
    tauri.invoke.mockResolvedValueOnce(view).mockResolvedValueOnce(receipt())
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)
    expect(await screen.findByText("自动 · Work · Chrome · Default")).toBeVisible()
    const header = screen.getByRole("button", { name: "账号" })
    expect(header).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    await user.click(header)
    await user.click(screen.getByRole("button", { name: "刷新账号" }))
    expect(header).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("radio", { name: "Work" })).toBeVisible()
  })
  it("shows stale and unavailable states while collapsed", async () => {
    tauri.invoke.mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0], stale: true, connections: [{ ...view.accounts[0].connections[0], available: false }] }] })
    render(<ProviderAccountControls providerId="cursor" />)
    expect(await screen.findByText("连接不可用")).toBeVisible()
    expect(screen.getAllByText("数据可能已过期").some((element) => !element.closest("[hidden]"))).toBe(true)
  })
  it("cancels without a mutation then removes selected account and refreshes usage", async () => {
    tauri.invoke.mockResolvedValueOnce(view).mockResolvedValueOnce(receipt({ ...view, activeAccountId: null, accounts: [] }))
    const refresh = vi.fn(), user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" onAccountChangeRefresh={refresh} />)
    await screen.findByText("自动 · Work · Chrome · Default")
    await user.click(screen.getByRole("button", { name: "账号" }))
    await user.click(screen.getByRole("button", { name: "移除 Work" }))
    expect(screen.getByText(/不会退出外部应用/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "移除 Work" }))
    await user.click(screen.getByRole("button", { name: "确认移除" }))
    expect(await screen.findByText("未连接账号")).toBeVisible()
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", { providerId: "cursor", operation: { kind: "removeAccount", accountId: "a" } })
    expect(refresh).toHaveBeenCalledOnce()
  })
  it("retains the account and confirmation when removal fails", async () => {
    tauri.invoke.mockResolvedValueOnce(view).mockResolvedValueOnce({ ...receipt(view, "failed"), error: { code: "failed", message: "无法移除，请重试" } })
    const user = userEvent.setup(), refresh = vi.fn()
    render(<ProviderAccountControls providerId="cursor" onAccountChangeRefresh={refresh} />)
    await screen.findByText("自动 · Work · Chrome · Default")
    await user.click(screen.getByRole("button", { name: "账号" }))
    await user.click(screen.getByRole("button", { name: "移除 Work" }))
    await user.click(screen.getByRole("button", { name: "确认移除" }))
    expect(await screen.findByText("无法移除，请重试")).toBeVisible()
    expect(screen.getByRole("button", { name: "确认移除" })).toBeEnabled()
    expect(refresh).not.toHaveBeenCalled()
  })
  it("offers cache cleanup retry even when failed removal already removed the account", async () => {
    const removed = { ...view, activeAccountId: null, accounts: [] }
    tauri.invoke.mockResolvedValueOnce(view)
      .mockResolvedValueOnce({ ...receipt(removed, "failed"), error: { code: "cleanup", message: "缓存清理失败" } })
      .mockResolvedValueOnce(receipt(removed))
    const user = userEvent.setup(), refresh = vi.fn()
    render(<ProviderAccountControls providerId="cursor" onAccountChangeRefresh={refresh} />)
    await screen.findByText("自动 · Work · Chrome · Default")
    await user.click(screen.getByRole("button", { name: "账号" }))
    await user.click(screen.getByRole("button", { name: "移除 Work" }))
    await user.click(screen.getByRole("button", { name: "确认移除" }))
    expect(await screen.findByText("Work 已移除，本地缓存清理尚未完成。")).toBeVisible()
    expect(refresh).toHaveBeenCalledOnce()
    await user.click(screen.getByRole("button", { name: "重试清理缓存" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试清理缓存" })).not.toBeInTheDocument())
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor", operation: { kind: "removeAccount", accountId: "a" },
    })
  })
  it("blocks removing another account until pending cache cleanup succeeds", async () => {
    const second = { ...view.accounts[0], accountId: "b", label: "Personal", selected: false }
    const initial = { ...view, accounts: [...view.accounts, second] }
    const removed = { ...view, activeAccountId: null, accounts: [second] }
    tauri.invoke.mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...receipt(removed, "failed"), error: { code: "cleanup", message: "缓存清理失败" } })
      .mockResolvedValueOnce(receipt(removed))
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)
    await screen.findByText("自动 · Work · Chrome · Default")
    await user.click(screen.getByRole("button", { name: "账号" }))
    await user.click(screen.getByRole("button", { name: "移除 Work" }))
    await user.click(screen.getByRole("button", { name: "确认移除" }))
    const retry = await screen.findByRole("button", { name: "重试清理缓存" })
    const removeSecond = screen.getByRole("button", { name: "移除 Personal" })
    expect(removeSecond).toBeDisabled()
    await user.click(removeSecond)
    expect(tauri.invoke).toHaveBeenCalledTimes(2)
    expect(retry).toBeEnabled()
    await user.click(retry)
    await waitFor(() => expect(removeSecond).toBeEnabled())
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor", operation: { kind: "removeAccount", accountId: "a" },
    })
  })
  it("reconnects local accounts only through the explicit action", async () => {
    tauri.invoke.mockResolvedValueOnce(view).mockResolvedValueOnce(receipt())
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)
    await screen.findByText("自动 · Work · Chrome · Default")
    await user.click(screen.getByRole("button", { name: "账号" }))
    await user.click(screen.getByRole("button", { name: "重新添加本机账号" }))
    await waitFor(() => expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", { providerId: "cursor", operation: { kind: "reconnectLocal" } }))
  })
})
