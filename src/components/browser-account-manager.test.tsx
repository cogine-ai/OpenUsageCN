import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { BrowserAccountManager } from "@/components/browser-account-manager"

function discovered(candidateId = "candidate-1", expiresAtMs = Date.now() + 60_000) {
  return { browser: "Chrome", provider: "Cursor", partial: false, profiles: [{ profileKey: "Profile 2", status: "verified", candidate: { candidateId, provider: "Cursor", browser: "Chrome", profileKey: "Profile 2", host: "cursor.com", expiresAtMs, identity: { email: "work@example.com", name: "Work User" } } }] }
}
function receipt(status = "succeeded") {
  return { operationId: "operation-1", status, sourceOutcomes: [], view: { providerId: "cursor", selection: { mode: "pinned", accountId: "account-1" }, activeAccountId: "account-1", accounts: [] } }
}
function mockProfiles() {
  tauri.invoke.mockImplementation((command: string) => {
    if (command === "list_browser_profiles") return Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }, { profileKey: "Default", displayName: "Main" }] })
    if (command === "discover_browser_accounts") return Promise.resolve(discovered())
    if (command === "cancel_browser_discovery") return Promise.resolve(true)
    throw new Error(`Unexpected ${command}`)
  })
}
async function checkWork(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "添加账号" }))
  await user.click(screen.getByRole("button", { name: "Chrome" }))
  await user.click(await screen.findByRole("button", { name: "Work" }))
}

describe("BrowserAccountManager", () => {
  beforeEach(() => { tauri.invoke.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it("does not read credentials when opening or listing browser profiles", async () => {
    mockProfiles()
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)
    expect(tauri.invoke).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "添加账号" }))
    expect(tauri.invoke).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    expect(await screen.findByRole("button", { name: "Work" })).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
    expect(tauri.invoke).toHaveBeenCalledWith("list_browser_profiles", { browser: "Chrome" })
    expect(screen.getByRole("button", { name: "Chrome" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("keeps explicit profile choice inside StrictMode", async () => {
    mockProfiles()
    const user = userEvent.setup()
    render(<StrictMode><BrowserAccountManager busy={false} onAttach={vi.fn()} /></StrictMode>)
    await checkWork(user)
    expect(await screen.findByRole("radio", { name: /work@example.com/ })).toBeChecked()
  })

  it("checks the chosen profile directly and attaches the selected identity", async () => {
    mockProfiles()
    const onAttach = vi.fn().mockResolvedValue(receipt())
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={onAttach} />)
    await checkWork(user)
    expect(await screen.findByRole("radio", { name: /work@example.com/ })).toBeChecked()
    expect(screen.getByText("Work User")).toBeInTheDocument()
    expect(screen.getByText("Chrome · Work")).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", { requestId: expect.any(String), providerId: "cursor", browser: "Chrome", profileKey: "Profile 2" })
    await user.click(screen.getByRole("button", { name: "添加所选账号" }))
    expect(onAttach).toHaveBeenCalledWith("candidate-1")
    expect(screen.getByRole("button", { name: "添加账号" })).toBeInTheDocument()
  })

  it("shows no successful identity or add action when display identity is missing", async () => {
    mockProfiles()
    const result = discovered()
    // A malformed native response must not become a fictitious user identity.
    delete (result.profiles[0].candidate as { identity?: unknown }).identity
    tauri.invoke.mockImplementation((command: string) => command === "list_browser_profiles"
      ? Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }] }) : Promise.resolve(result))
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)
    await checkWork(user)
    expect(await screen.findByText("身份未确认")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "添加所选账号" })).not.toBeInTheDocument()
  })

  it("requires an explicitly selected exact profile for Claude", async () => {
    mockProfiles()
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} providerId="claude" onAttach={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "连接浏览器" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await screen.findByRole("button", { name: "Work" })
    expect(screen.queryByRole("button", { name: "查找此浏览器全部账号" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Work" }))
    await screen.findByRole("button", { name: "连接所选浏览器" })
    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", { requestId: expect.any(String), providerId: "claude", browser: "Chrome", profileKey: "Profile 2" })
  })

  it("finds all Cursor profiles only after its separate explicit action", async () => {
    mockProfiles()
    const results = discovered()
    tauri.invoke.mockImplementation((command: string) => command === "list_browser_profiles"
      ? Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }, { profileKey: "Default", displayName: "Main" }] })
      : Promise.resolve({ ...results, partial: true, profiles: [...results.profiles, { profileKey: "Default", status: "empty" }, { profileKey: "Profile 3", status: "failed", error: { code: "cookieReadFailed", message: "Browser cookies could not be read." } }] }))
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "添加账号" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.click(await screen.findByRole("button", { name: "查找此浏览器全部账号" }))
    expect(await screen.findByText("部分来源暂时不可用")).toBeInTheDocument()
    expect(screen.getByText("未登录")).toBeInTheDocument()
    expect(screen.getByText("无法读取此浏览器的登录")).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", { requestId: expect.any(String), providerId: "cursor", browser: "Chrome" })
  })

  it("preserves the identity after attachment failure and checks the same source again", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mockProfiles()
    let checks = 0
    tauri.invoke.mockImplementation((command: string) => command === "list_browser_profiles"
      ? Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }] }) : Promise.resolve(discovered(`candidate-${++checks}`)))
    const onAttach = vi.fn().mockResolvedValueOnce(receipt("failed")).mockResolvedValueOnce(receipt())
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={onAttach} />)
    await checkWork(user)
    await user.click(await screen.findByRole("button", { name: "添加所选账号" }))
    expect(screen.getByText("work@example.com")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "添加所选账号" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "重新检查此来源" }))
    await user.click(await screen.findByRole("button", { name: "添加所选账号" }))
    expect(onAttach.mock.calls).toEqual([["candidate-1"], ["candidate-2"]])
    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", { requestId: expect.any(String), providerId: "cursor", browser: "Chrome", profileKey: "Profile 2" })
    errorSpy.mockRestore()
  })

  it("requires a new check when a candidate is already expired", async () => {
    mockProfiles()
    tauri.invoke.mockImplementation((command: string) => command === "list_browser_profiles"
      ? Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }] }) : Promise.resolve(discovered("expired", Date.now() - 1)))
    const onAttach = vi.fn()
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={onAttach} />)
    await checkWork(user)
    expect(await screen.findByRole("button", { name: "重新检查此来源" })).toBeInTheDocument()
    expect(onAttach).not.toHaveBeenCalled()
  })

  it("changes the action when the visible result expires and rechecks its exact source", async () => {
    vi.useFakeTimers()
    let checks = 0
    tauri.invoke.mockImplementation((command: string) => command === "list_browser_profiles"
      ? Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }] })
      : Promise.resolve(discovered(`candidate-${++checks}`, Date.now() + (checks === 1 ? 1_000 : 60_000))))
    const onAttach = vi.fn().mockResolvedValue(receipt())
    render(<BrowserAccountManager busy={false} onAttach={onAttach} />)
    fireEvent.click(screen.getByRole("button", { name: "添加账号" }))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Chrome" })) })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Work" })) })
    expect(screen.getByRole("button", { name: "添加所选账号" })).toBeEnabled()
    await act(async () => { vi.advanceTimersByTime(1_001) })
    expect(screen.getByText("work@example.com")).toBeVisible()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新检查此来源" })) })
    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", { requestId: expect.any(String), providerId: "cursor", browser: "Chrome", profileKey: "Profile 2" })
    expect(onAttach).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "添加所选账号" })) })
    expect(onAttach).toHaveBeenCalledWith("candidate-2")
  })

  it("does not attach twice during an in-flight operation", async () => {
    mockProfiles()
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const onAttach = vi.fn().mockReturnValue(pending)
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={onAttach} />)
    await checkWork(user)
    const button = await screen.findByRole("button", { name: "添加所选账号" })
    await user.click(button)
    expect(button).toBeDisabled()
    await user.click(button)
    expect(onAttach).toHaveBeenCalledTimes(1)
    await act(async () => { finish(receipt()); await pending })
  })

  it("cancels an in-flight discovery when the manager unmounts", async () => {
    mockProfiles()
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") return Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }] })
      if (command === "discover_browser_accounts") return new Promise(() => {})
      return Promise.resolve(true)
    })
    const user = userEvent.setup()
    const { unmount } = render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)
    await checkWork(user)
    const request = tauri.invoke.mock.calls.find(([command]) => command === "discover_browser_accounts")
    unmount()
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", { requestId: request?.[1].requestId })
  })

  it("shows the standalone flow without accessing any browser", () => {
    const onClose = vi.fn()
    render(<BrowserAccountManager standalone busy={false} onClose={onClose} onAttach={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "添加账号" })).toBeInTheDocument()
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it("lets the keyboard select an exact identity from multiple discovered sources", async () => {
    const first = discovered()
    tauri.invoke.mockImplementation((command: string) => command === "list_browser_profiles"
      ? Promise.resolve({ profiles: [{ profileKey: "Profile 2", displayName: "Work" }, { profileKey: "Default", displayName: "Main" }] })
      : Promise.resolve({ ...first, profiles: [...first.profiles, { profileKey: "Default", status: "verified", candidate: { ...first.profiles[0].candidate, candidateId: "personal", profileKey: "Default", identity: { email: "personal@example.com" } } }] }))
    const onAttach = vi.fn().mockResolvedValue(receipt())
    const user = userEvent.setup()
    render(<BrowserAccountManager standalone busy={false} onAttach={onAttach} />)
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.click(await screen.findByRole("button", { name: "查找此浏览器全部账号" }))
    const work = await screen.findByRole("radio", { name: /work@example.com/ })
    work.focus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("radio", { name: /personal@example.com/ })).toBeChecked()
    expect(screen.getByRole("radio", { name: /personal@example.com/ })).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "添加所选账号" }))
    expect(onAttach).toHaveBeenCalledWith("personal")
  })

})
