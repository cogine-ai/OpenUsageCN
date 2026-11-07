import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderAccountOperationReceipt, ProviderAccountView } from "@/lib/plugin-types"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { ProviderAccountControls } from "./provider-account-controls"

const view: ProviderAccountView = {
  providerId: "cursor", selection: { mode: "auto" }, activeAccountId: "work",
  accounts: [
    { accountId: "work", label: "Work", identity: { email: "work@example.com" }, connectionKinds: ["desktop"], connections: [], selected: true, stale: false },
    { accountId: "personal", label: "Personal", connectionKinds: ["chrome"], connections: [], selected: false, stale: false },
  ],
}
function receipt(next: ProviderAccountView): ProviderAccountOperationReceipt {
  return { operationId: "op", status: "succeeded", sourceOutcomes: [], view: next }
}
const pinned = (accountId: string): ProviderAccountView => ({
  ...view, selection: { mode: "pinned", accountId }, activeAccountId: accountId,
})

describe("Account Selection", () => {
  beforeEach(() => { tauri.invoke.mockReset(); tauri.listen.mockResolvedValue(vi.fn()) })

  it("checks only automatic mode while marking the actual projected identity separately", async () => {
    tauri.invoke.mockResolvedValue(view)
    render(<ProviderAccountControls providerId="cursor" standalone />)
    const group = await screen.findByRole("radiogroup", { name: "账号选择" })
    const auto = within(group).getByRole("radio", { name: "跟随本机" })
    const work = within(group).getByRole("radio", { name: /work@example.com/ })
    expect(within(group).getAllByRole("radio", { checked: true })).toEqual([auto])
    expect(auto).toHaveAttribute("tabindex", "0")
    expect(work).toHaveAttribute("tabindex", "-1")
    expect(within(auto).getByText("work@example.com")).toBeVisible()
    expect(within(auto).getByLabelText("当前账号")).toBeVisible()
    expect(within(work).queryByLabelText("当前账号")).not.toBeInTheDocument()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
  })

  it("checks the pinned selection even when it has no current projection", async () => {
    tauri.invoke.mockResolvedValue({ ...pinned("personal"), activeAccountId: null })
    render(<ProviderAccountControls providerId="cursor" standalone />)
    const auto = await screen.findByRole("radio", { name: "跟随本机" })
    const personal = screen.getByRole("radio", { name: /Personal/ })
    expect(personal).toBeChecked()
    expect(personal).toHaveAttribute("tabindex", "0")
    expect(auto).not.toBeChecked()
    expect(auto).toHaveAttribute("tabindex", "-1")
    expect(within(auto).queryByText("work@example.com")).not.toBeInTheDocument()
  })

  it("navigates one radio group from automatic to fixed accounts and back", async () => {
    tauri.invoke.mockResolvedValueOnce(view)
      .mockResolvedValueOnce(receipt(pinned("work")))
      .mockResolvedValueOnce(receipt(pinned("personal")))
      .mockResolvedValueOnce(receipt(view))
    const refresh = vi.fn(), user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" standalone onAccountChangeRefresh={refresh} />)
    const auto = await screen.findByRole("radio", { name: "跟随本机" })
    auto.focus()
    await user.keyboard("{ArrowRight}")
    const work = screen.getByRole("radio", { name: /work@example.com/ })
    await waitFor(() => expect(work).toBeChecked())
    expect(work).toHaveFocus()
    expect(refresh).not.toHaveBeenCalled()
    await user.keyboard("{ArrowDown}")
    const personal = screen.getByRole("radio", { name: /Personal/ })
    await waitFor(() => expect(personal).toBeChecked())
    expect(personal).toHaveFocus()
    await user.keyboard("{ArrowRight}")
    await waitFor(() => expect(auto).toBeChecked())
    expect(auto).toHaveFocus()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor", operation: { kind: "followDefaultConnection" },
    })
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1)
    expect(screen.getAllByRole("radio").filter((radio) => radio.tabIndex === 0)).toEqual([auto])
  })

  it("retains the pinned choice and visible failure when following the local login fails", async () => {
    const initial = pinned("personal")
    tauri.invoke.mockResolvedValueOnce(initial).mockResolvedValueOnce({
      ...receipt(initial), status: "failed", error: { code: "noDefault", message: "没有可用的本机账号" },
    })
    const refresh = vi.fn()
    render(<ProviderAccountControls providerId="cursor" standalone onAccountChangeRefresh={refresh} />)
    await userEvent.setup().click(await screen.findByRole("radio", { name: "跟随本机" }))
    expect(await screen.findByText("没有可用的本机账号")).toBeVisible()
    expect(screen.getByRole("radio", { name: /Personal/ })).toBeChecked()
    expect(screen.getByRole("radio", { name: "跟随本机" })).not.toBeChecked()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("disables all choices during an account operation", async () => {
    let finish!: (value: ProviderAccountOperationReceipt) => void
    tauri.invoke.mockResolvedValueOnce(view).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<ProviderAccountControls providerId="cursor" standalone />)
    await userEvent.setup().click(await screen.findByRole("radio", { name: /Personal/ }))
    expect(screen.getAllByRole("radio").every((radio) => (radio as HTMLButtonElement).disabled)).toBe(true)
    finish(receipt(pinned("personal")))
    await waitFor(() => expect(screen.getByRole("radio", { name: /Personal/ })).toBeEnabled())
  })

  it.each([
    { mode: "fixed", status: "succeeded" }, { mode: "fixed", status: "failed" },
    { mode: "auto", status: "succeeded" }, { mode: "auto", status: "failed" },
  ] as const)("restores keyboard focus after delayed $mode selection $status", async ({ mode, status }) => {
    const initial = pinned(mode === "fixed" ? "work" : "personal")
    const next = mode === "fixed" ? pinned("personal") : view
    let finish!: (value: ProviderAccountOperationReceipt) => void
    tauri.invoke.mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(receipt(mode === "fixed" ? view : pinned("work")))
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" standalone />)
    const start = await screen.findByRole("radio", { name: mode === "fixed" ? /work@example.com/ : /Personal/ })
    start.focus()
    await user.keyboard("{ArrowRight}")
    const target = screen.getByRole("radio", { name: mode === "fixed" ? /Personal/ : "跟随本机" })
    expect(target).toBeDisabled()
    target.blur() // WebKit can drop focus when the in-flight radio becomes disabled.
    expect(document.body).toHaveFocus()
    await act(async () => { finish(status === "succeeded" ? receipt(next) : {
      ...receipt(initial), status: "failed", error: { code: "selectionFailed", message: "无法切换账号" },
    }) })
    await waitFor(() => expect(target).toBeEnabled())
    expect(target).toHaveFocus()
    if (status === "failed") {
      expect(start).toBeChecked()
      expect(target).not.toBeChecked()
      expect(screen.getByText("无法切换账号")).toBeVisible()
    } else expect(target).toBeChecked()
    await user.keyboard("{ArrowRight}")
    const following = screen.getByRole("radio", { name: mode === "fixed" ? "跟随本机" : /work@example.com/ })
    await waitFor(() => expect(following).toBeChecked())
    expect(following).toHaveFocus()
  })

  it("does not reclaim focus after the user moves to another control", async () => {
    let finish!: (value: ProviderAccountOperationReceipt) => void
    tauri.invoke.mockResolvedValueOnce(view).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<><ProviderAccountControls providerId="cursor" standalone /><button>其他操作</button></>)
    const user = userEvent.setup()
    const auto = await screen.findByRole("radio", { name: "跟随本机" })
    auto.focus()
    await user.keyboard("{ArrowRight}")
    const elsewhere = screen.getByRole("button", { name: "其他操作" })
    elsewhere.focus()
    await act(async () => { finish(receipt(pinned("work"))) })
    expect(elsewhere).toHaveFocus()
  })

  it("does not focus a radio activated without owning focus", async () => {
    let finish!: (value: ProviderAccountOperationReceipt) => void
    tauri.invoke.mockResolvedValueOnce(view).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<ProviderAccountControls providerId="cursor" standalone />)
    const target = await screen.findByRole("radio", { name: /Personal/ })
    fireEvent.click(target)
    expect(document.body).toHaveFocus()
    await act(async () => { finish(receipt(pinned("personal"))) })
    expect(document.body).toHaveFocus()
  })
})
