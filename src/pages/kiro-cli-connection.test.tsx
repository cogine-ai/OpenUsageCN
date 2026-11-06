import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getPluginRecovery } from "@/lib/plugin-recovery"
import { ProviderCard } from "@/components/provider-card"
import { ProviderConnectionPage } from "@/pages/provider-connection"
import { useAppUiStore } from "@/stores/app-ui-store"
const clipboard = vi.fn().mockResolvedValue(undefined)
const plugin = { id: "kiro", name: "Kiro", enabled: true }
const loginErrors = ["Run kiro-cli login, then refresh Kiro usage.", "Kiro CLI session expired. Run kiro-cli login again.", "Kiro CLI sign-in data is invalid. Run kiro-cli login again."]
beforeEach(() => {
  clipboard.mockClear()
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } })
  useAppUiStore.getState().resetState()
})
describe("Kiro CLI Login Recovery", () => {
  it.each(loginErrors)("routes the fixed authentication message to local login: %s", (error) => {
    const recovery = getPluginRecovery(error, "kiro")
    expect(recovery).toMatchObject({ action: "local", kind: "login", advice: expect.stringContaining("kiro-cli login") })
    const onRecovery = vi.fn(), onRetry = vi.fn()
    render(<ProviderCard providerId="kiro" name="Kiro" displayMode="used" error={error} onRecovery={onRecovery} onRetry={onRetry} />)
    fireEvent.click(screen.getAllByRole("button", { name: "连接本机账号" })[0])
    expect(onRecovery).toHaveBeenCalledWith(expect.objectContaining({ action: "local" }))
    expect(onRetry).not.toHaveBeenCalled()
  })
  it("copies the supported CLI command and verifies only on explicit check", async () => {
    useAppUiStore.getState().openConnection("kiro", "local")
    const onCheck = vi.fn().mockResolvedValue(undefined)
    render(<ProviderConnectionPage plugin={plugin} error={loginErrors[0]} onCheck={onCheck} onAccountChangeRefresh={vi.fn()} />)
    expect(screen.getByText("kiro-cli login", { selector: "code" })).toBeVisible()
    expect(onCheck).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "复制登录命令" }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledExactlyOnceWith("kiro-cli login"))
    expect(onCheck).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "检查连接", exact: true }))
    await waitFor(() => expect(onCheck).toHaveBeenCalledExactlyOnceWith("kiro"))
  })
  it("retains the desktop login instructions without showing a CLI command", () => {
    useAppUiStore.getState().openConnection("kiro", "local")
    render(<ProviderConnectionPage plugin={plugin} error="Kiro session expired. Open Kiro and sign in again." onCheck={vi.fn()} onAccountChangeRefresh={vi.fn()} />)
    expect(screen.getByText("在 Kiro 中重新登录。")).toBeVisible()
    expect(screen.queryByRole("button", { name: "复制登录命令" })).not.toBeInTheDocument()
  })
  it.each(["Kiro CLI denied access to usage data. Check your CLI account.", "Kiro CLI sign-in data could not be read. Open Kiro CLI and try again.", "Kiro CLI profile is invalid or its region is unsupported. Check your CLI sign-in.", "Other error: Run kiro-cli login, then refresh Kiro usage."])("does not treat another failure as the fixed CLI login flow: %s", (error) => {
    expect(getPluginRecovery(error, "kiro").kind).not.toBe("login")
  })
})
