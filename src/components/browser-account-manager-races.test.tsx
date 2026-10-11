import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

import { BrowserAccountManager } from "@/components/browser-account-manager"

describe("BrowserAccountManager response ordering", () => {
  it("keeps a newer Arc profile list when a closed Chrome request resolves late", async () => {
    let resolveChrome!: (value: unknown) => void
    const chromeRequest = new Promise((resolve) => {
      resolveChrome = resolve
    })
    tauri.invoke.mockImplementation((command: string, args: { browser?: string }) => {
      if (command !== "list_browser_profiles") throw new Error(`Unexpected ${command}`)
      if (args.browser === "Chrome") return chromeRequest
      return Promise.resolve({
        profiles: [{ profileKey: "Default", displayName: "Arc Main" }],
      })
    })

    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "添加账号" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    expect(screen.getByRole("status")).toHaveTextContent("正在读取配置文件")
    await user.click(screen.getByRole("button", { name: "关闭账号连接" }))
    await user.click(screen.getByRole("button", { name: "添加账号" }))
    await user.click(screen.getByRole("button", { name: "Arc" }))
    expect(await screen.findByRole("button", { name: "Arc Main" })).toBeInTheDocument()

    await act(async () => {
      resolveChrome({
        profiles: [{ profileKey: "Profile 2", displayName: "Chrome Work" }],
      })
      await chromeRequest
    })

    expect(screen.getByRole("button", { name: "Arc Main" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Chrome Work" })).toBeNull()
  })
})

describe("BrowserAccountManager discovery ownership", () => {
  it("ignores a canceled Chrome identity after switching to Arc", async () => {
    let resolveChrome!: (value: unknown) => void
    const pending = new Promise((resolve) => { resolveChrome = resolve })
    tauri.invoke.mockImplementation((command: string, args: { browser?: string }) => {
      if (command === "list_browser_profiles") return Promise.resolve({ profiles: [{ profileKey: "Default", displayName: args.browser === "Chrome" ? "Chrome Main" : "Arc Main" }] })
      if (command === "discover_browser_accounts") return pending
      if (command === "cancel_browser_discovery") return Promise.resolve(true)
      throw new Error(`Unexpected ${command}`)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager standalone busy={false} onAttach={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.click(await screen.findByRole("button", { name: "Chrome Main" }))
    const request = tauri.invoke.mock.calls.find(([command]) => command === "discover_browser_accounts")
    await user.click(screen.getByRole("button", { name: "Arc" }))
    expect(await screen.findByRole("button", { name: "Arc Main" })).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", { requestId: request?.[1].requestId })
    await act(async () => {
      resolveChrome({ browser: "Chrome", provider: "Cursor", partial: false, profiles: [{ profileKey: "Default", status: "verified", candidate: { candidateId: "old", expiresAtMs: Date.now() + 60_000, identity: { email: "old@example.com" } } }] })
      await pending
    })
    expect(screen.queryByText("old@example.com")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "添加所选账号" })).not.toBeInTheDocument()
  })

  it("ignores a result arriving after explicit cancellation", async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") return Promise.resolve({ profiles: [{ profileKey: "Default", displayName: "Main" }] })
      if (command === "discover_browser_accounts") return pending
      return Promise.resolve(true)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager standalone busy={false} onAttach={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.click(await screen.findByRole("button", { name: "Main" }))
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(screen.getByRole("button", { name: "Main" })).toBeEnabled()
    await act(async () => { finish({ profiles: [{ profileKey: "Default", status: "empty" }] }); await pending })
    expect(screen.queryByText("未登录")).not.toBeInTheDocument()
  })
})
