import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}))

import { ProviderAccountControls } from "@/components/provider-account-controls"

describe("ProviderAccountControls", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listen.mockResolvedValue(vi.fn())
  })

  it("shows the loaded accounts and automatic selection", async () => {
    tauri.invoke.mockResolvedValue({
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: "account-1",
      accounts: [
        {
          accountId: "account-1",
          label: "Work",
          connectionKinds: ["desktop", "cli"],
          connections: [],
          selected: true,
          stale: false,
        },
        {
          accountId: "account-2",
          label: "Personal",
          connectionKinds: ["desktop"],
          connections: [],
          selected: false,
          stale: true,
        },
      ],
    })

    render(<ProviderAccountControls providerId="cursor" />)

    expect(screen.getByText("正在读取账号…")).toBeInTheDocument()
    expect(await screen.findByRole("heading", { name: "Provider Accounts" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /自动跟随/i })).toBeChecked()
    expect(screen.getByRole("radio", { name: /Work/i })).not.toBeChecked()
    expect(screen.getByText("Desktop · CLI")).toBeInTheDocument()
    expect(screen.getByText("数据可能已过期")).toBeInTheDocument()
  })

  it("pins an account selected by the user", async () => {
    const initialView = {
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: "account-1",
      accounts: [
        {
          accountId: "account-1",
          label: "Work",
          connectionKinds: ["desktop"],
          connections: [],
          selected: true,
          stale: false,
        },
      ],
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce({
        operationId: "operation-1",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          ...initialView,
          selection: { mode: "pinned", accountId: "account-1" },
        },
      })
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)
    const account = await screen.findByRole("radio", { name: /Work/i })

    await user.click(account)

    expect(account).toBeChecked()
    expect(screen.getByRole("radio", { name: /自动跟随/i })).not.toBeChecked()
  })

  it("keeps a partial refresh result visible", async () => {
    const view = {
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: "account-1",
      accounts: [],
    }
    tauri.invoke
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce({
        operationId: "operation-2",
        status: "partial",
        sourceOutcomes: [
          { sourceKey: "cursorDesktop", status: "available" },
          { sourceKey: "cursorCli", status: "unavailable" },
        ],
        view,
      })
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)

    await user.click(await screen.findByRole("button", { name: "刷新账号" }))

    expect(screen.getByRole("heading", { name: "Account Refresh Partial" })).toBeInTheDocument()
    expect(screen.getByText("cursorCli 暂时不可用，已保留其他来源的数据。")).toBeInTheDocument()
  })

  it("keeps a failed operation and its friendly message visible", async () => {
    const view = {
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: null,
      accounts: [],
    }
    tauri.invoke
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce({
        operationId: "operation-3",
        status: "failed",
        sourceOutcomes: [{ sourceKey: "cursorDesktop", status: "unavailable" }],
        view,
        error: {
          code: "refreshFailed",
          message: "Cursor account refresh failed. Try again.",
        },
      })
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)

    await user.click(await screen.findByRole("button", { name: "刷新账号" }))

    expect(screen.getByRole("heading", { name: "Account Operation Failed" })).toBeInTheDocument()
    expect(screen.getByText("Cursor account refresh failed. Try again.")).toBeInTheDocument()
  })

  it("keeps a persistence warning visible with its correlation id", async () => {
    tauri.invoke.mockResolvedValue({
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: null,
      accounts: [],
      persistenceWarning: {
        code: "persistenceUnavailable",
        message: "Account data is unavailable. Restore storage access and restart the app.",
        correlationId: "correlation-7",
      },
    })

    render(<ProviderAccountControls providerId="cursor" />)

    expect(
      await screen.findByRole("heading", { name: "Account Storage Warning" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("Account data is unavailable. Restore storage access and restart the app.")
    ).toBeInTheDocument()
    expect(screen.getByText("Reference: correlation-7")).toBeInTheDocument()
  })

  it("renames an account from its inline editor", async () => {
    const initialView = {
      providerId: "cursor",
      selection: { mode: "auto" },
      activeAccountId: "account-1",
      accounts: [
        {
          accountId: "account-1",
          label: "Work",
          connectionKinds: ["desktop"],
          connections: [],
          selected: true,
          stale: false,
        },
      ],
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce({
        operationId: "operation-4",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          ...initialView,
          accounts: [{ ...initialView.accounts[0], label: "Personal" }],
        },
      })
    const user = userEvent.setup()
    render(<ProviderAccountControls providerId="cursor" />)

    await user.click(await screen.findByRole("button", { name: "重命名 Work" }))
    const input = screen.getByRole("textbox", { name: "账号名称" })
    await user.clear(input)
    await user.type(input, "Personal")
    await user.click(screen.getByRole("button", { name: "保存名称" }))

    expect(await screen.findByText("Personal")).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "账号名称" })).not.toBeInTheDocument()
  })

  it("shows browser profile status and detaches one exact connection", async () => {
    const initialView = {
      providerId: "cursor",
      selection: { mode: "pinned", accountId: "account-1" },
      activeAccountId: "account-1",
      accounts: [
        {
          accountId: "account-1",
          label: "Work",
          connectionKinds: ["chrome", "arc"],
          connections: [
            {
              connectionId: "connection-chrome",
              kind: "chrome",
              available: true,
              profileKey: "Profile 2",
            },
            {
              connectionId: "connection-arc",
              kind: "arc",
              available: false,
              profileKey: "Default",
            },
          ],
          selected: true,
          stale: false,
        },
      ],
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce({
        operationId: "operation-detach",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          ...initialView,
          accounts: [
            {
              ...initialView.accounts[0],
              connectionKinds: ["arc"],
              connections: [initialView.accounts[0].connections[1]],
              stale: true,
            },
          ],
        },
      })
    const user = userEvent.setup()

    render(<ProviderAccountControls providerId="cursor" browserBinding />)

    expect(
      await screen.findByRole("button", { name: "Add Browser Account" })
    ).toBeInTheDocument()
    expect(screen.getByText("Chrome · Profile 2")).toBeInTheDocument()
    expect(screen.getByText("Arc · Default")).toBeInTheDocument()
    expect(screen.getByText("Available")).toBeInTheDocument()
    expect(screen.getByText("Unavailable")).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Detach Chrome Profile 2" })
    )

    expect(screen.queryByText("Chrome · Profile 2")).not.toBeInTheDocument()
    expect(screen.getByText("Arc · Default")).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenLastCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation: {
        kind: "detachConnection",
        accountId: "account-1",
        connectionId: "connection-chrome",
      },
    })
  })

  it.each([
    { providerId: "cursor", browserBinding: false },
    { providerId: "codex", browserBinding: true },
  ])(
    "does not offer browser attachment for $providerId with binding $browserBinding",
    async ({ providerId, browserBinding }) => {
      tauri.invoke.mockResolvedValue({
        providerId,
        selection: { mode: "auto" },
        activeAccountId: null,
        accounts: [],
      })

      render(
        <ProviderAccountControls
          providerId={providerId}
          browserBinding={browserBinding}
        />
      )

      expect(await screen.findByRole("radio", { name: /自动跟随/i })).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Add Browser Account" })
      ).not.toBeInTheDocument()
    }
  )

  it("offers exact browser-profile attachment for Claude", async () => {
    tauri.invoke.mockResolvedValue({
      providerId: "claude",
      selection: { mode: "auto" },
      activeAccountId: "account-claude",
      accounts: [],
    })

    render(<ProviderAccountControls providerId="claude" browserBinding />)

    expect(
      await screen.findByRole("button", { name: "Add Browser Account" })
    ).toBeInTheDocument()
  })

  it("loads Cursor model history for the active account on detail demand", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_provider_account_view") {
        return Promise.resolve({
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "account-7",
          accounts: [],
        })
      }
      if (command === "get_cursor_history_snapshot") return Promise.resolve(null)
      if (command === "refresh_cursor_history") {
        return Promise.resolve({ snapshot: null, stale: false })
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    render(
      <ProviderAccountControls providerId="cursor" modelHistory />
    )

    expect(await screen.findByRole("heading", { name: "Model Usage" })).toBeInTheDocument()
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("get_cursor_history_snapshot", {
        providerId: "cursor",
        accountId: "account-7",
      })
    )
  })

  it.each([
    { providerId: "cursor", activeAccountId: null },
    { providerId: "codex", activeAccountId: "account-7" },
  ])(
    "does not load Cursor history for $providerId with active account $activeAccountId",
    async ({ providerId, activeAccountId }) => {
      tauri.invoke.mockResolvedValue({
        providerId,
        selection: { mode: "auto" },
        activeAccountId,
        accounts: [],
      })

      render(<ProviderAccountControls providerId={providerId} modelHistory />)

      expect(await screen.findByRole("radio", { name: /自动跟随/i })).toBeInTheDocument()
      expect(screen.queryByRole("heading", { name: "Model Usage" })).not.toBeInTheDocument()
      expect(tauri.invoke).not.toHaveBeenCalledWith(
        "get_cursor_history_snapshot",
        expect.anything()
      )
    }
  )
})
