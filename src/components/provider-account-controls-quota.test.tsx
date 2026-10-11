import { render as testingRender, fireEvent, screen, waitFor } from "@testing-library/react"
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

function renderControls(element: Parameters<typeof testingRender>[0]) {
  const result = testingRender(element)
  fireEvent.click(screen.getByRole("button", { name: "账号" }))
  return result
}

function account(accountId: string, label: string, selected: boolean) {
  return {
    accountId,
    label,
    connectionKinds: ["desktop" as const],
    connections: [],
    selected,
    stale: false,
  }
}

function baseView() {
  return {
    providerId: "cursor",
    selection: { mode: "pinned" as const, accountId: "account-1" },
    activeAccountId: "account-1",
    accounts: [
      account("account-1", "Work", true),
      account("account-2", "Personal", false),
    ],
  }
}

function receipt(view: ReturnType<typeof baseView>, status = "succeeded") {
  return {
    operationId: "operation-1",
    status,
    sourceOutcomes: [],
    view,
  }
}

describe("ProviderAccountControls quota refresh", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listen.mockResolvedValue(vi.fn())
  })

  it.each(["cursor", "claude"])("returns %s to the local default after its pinned account becomes inactive", async (providerId) => {
    const initialView = {
      ...baseView(), providerId, activeAccountId: null,
      accounts: [account("account-2", "Personal", false)],
    }
    const autoView = {
      ...baseView(), providerId, selection: { mode: "auto" as const }, activeAccountId: "account-2",
      accounts: [account("account-2", "Personal", true)],
    }
    tauri.invoke.mockResolvedValueOnce(initialView).mockResolvedValueOnce(receipt(autoView))
    const onAccountChangeRefresh = vi.fn()
    testingRender(<ProviderAccountControls standalone providerId={providerId} onAccountChangeRefresh={onAccountChangeRefresh} />)
    const followLocal = await screen.findByRole("switch", { name: "跟随本机" })
    expect(followLocal).toBeEnabled()
    expect(followLocal).not.toBeChecked()
    await userEvent.setup().click(followLocal)
    expect(tauri.invoke).toHaveBeenCalledWith("perform_provider_account_operation", {
      providerId, operation: { kind: "followDefaultConnection" },
    })
    await waitFor(() => expect(followLocal).toBeChecked())
    expect(screen.getByRole("radio", { name: /Personal/i })).toBeChecked()
    expect(onAccountChangeRefresh).toHaveBeenCalledOnce()
  })

  it("cannot pin an empty local default", async () => {
    tauri.invoke.mockResolvedValue({ ...baseView(), selection: { mode: "auto" }, activeAccountId: null, accounts: [] })
    testingRender(<ProviderAccountControls standalone providerId="cursor" />)
    const followLocal = await screen.findByRole("switch", { name: "跟随本机" })
    expect(followLocal).toBeChecked()
    expect(followLocal).toBeDisabled()
    await userEvent.setup().click(followLocal)
    expect(tauri.invoke).not.toHaveBeenCalledWith("perform_provider_account_operation", expect.anything())
  })

  it("refreshes quota after selecting an account and returning to Auto", async () => {
    const initialView = baseView()
    const selectedView = {
      ...initialView,
      selection: { mode: "pinned" as const, accountId: "account-2" },
      activeAccountId: "account-2",
    }
    const autoView = {
      ...initialView,
      selection: { mode: "auto" as const },
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce(receipt(selectedView))
      .mockResolvedValueOnce(receipt(autoView))
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="cursor"
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("radio", { name: /Personal/i }))
    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole("switch", { name: "跟随本机" }))
    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(2))
  })

  it("does not refresh quota when a successful selection keeps the active projection", async () => {
    const initialView = {
      ...baseView(),
      selection: { mode: "auto" as const },
    }
    const pinnedView = {
      ...initialView,
      selection: { mode: "pinned" as const, accountId: "account-1" },
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce(receipt(pinnedView))
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="cursor"
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("radio", { name: /Work/i }))
    await waitFor(() => expect(screen.getByRole("radio", { name: /Work/i })).toBeChecked())
    expect(onAccountChangeRefresh).not.toHaveBeenCalled()
  })

  it("refreshes quota when Refresh Active changes the projection", async () => {
    const initialView = baseView()
    const refreshedView = {
      ...initialView,
      activeAccountId: "account-2",
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce(receipt(refreshedView))
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="cursor"
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("button", { name: "刷新账号" }))

    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))
  })

  it("does not refresh quota for a failed account selection", async () => {
    const initialView = baseView()
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce(receipt(initialView, "failed"))
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="cursor"
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("radio", { name: /Personal/i }))
    expect(
      await screen.findByRole("heading", { name: "Account Operation Failed" })
    ).toBeInTheDocument()
    expect(onAccountChangeRefresh).not.toHaveBeenCalled()
  })

  it("refreshes quota once when detaching the active account connection", async () => {
    const initialView = baseView()
    initialView.accounts[0] = {
      ...initialView.accounts[0],
      connectionKinds: ["chrome"],
      connections: [
        {
          connectionId: "connection-1",
          kind: "chrome",
          available: true,
          profileKey: "Default",
        },
      ],
    }
    const detachedView = {
      ...initialView,
      accounts: [{ ...initialView.accounts[0], connections: [] }, initialView.accounts[1]],
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce(receipt(detachedView, "partial"))
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="cursor"
        browserBinding
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(
      await screen.findByRole("button", { name: "Detach Chrome Default" })
    )

    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))
  })

  it("refreshes quota when browser attachment changes the active account", async () => {
    const initialView = baseView()
    const attachedView = {
      ...initialView,
      selection: { mode: "pinned" as const, accountId: "account-2" },
      activeAccountId: "account-2",
    }
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_provider_account_view") return Promise.resolve(initialView)
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Default", displayName: "Main" }],
        })
      }
      if (command === "discover_browser_accounts") {
        return Promise.resolve({
          browser: "Chrome",
          provider: "Cursor",
          profiles: [
            {
              profileKey: "Default",
              status: "verified",
              candidate: {
                candidateId: "candidate-1",
                provider: "Cursor",
                browser: "Chrome",
                profileKey: "Default",
                host: "cursor.com",
                expiresAtMs: Date.now() + 60_000,
                identity: { email: "work@example.com" },
              },
            },
          ],
          partial: false,
        })
      }
      if (command === "perform_provider_account_operation") {
        return Promise.resolve(receipt(attachedView))
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="cursor"
        browserBinding
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("button", { name: "添加账号" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.click(await screen.findByRole("button", { name: "Main" }))
    await user.click(await screen.findByRole("button", { name: "添加所选账号" }))

    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))
  })

  it("refreshes Claude quota when browser attachment enriches the same OAuth account", async () => {
    const initialView = {
      ...baseView(),
      providerId: "claude",
      accounts: [
        {
          ...account("account-1", "Claude Team", true),
          connectionKinds: ["cli" as const],
          connections: [{ connectionId: "claude-cli", kind: "cli" as const, available: true }],
        },
      ],
    }
    const attachedView = {
      ...initialView,
      accounts: [
        {
          ...initialView.accounts[0],
          connectionKinds: ["cli" as const, "chrome" as const],
          connections: [
            {
              connectionId: "connection-claude-browser",
              kind: "chrome" as const,
              available: true,
              profileKey: "Default",
            },
          ],
        },
      ],
    }
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_platform_capabilities") return Promise.resolve({ platform: "macos" })
      if (command === "get_provider_account_view") return Promise.resolve(initialView)
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Default", displayName: "Main" }],
        })
      }
      if (command === "discover_browser_accounts") {
        return Promise.resolve({
          browser: "Chrome",
          provider: "Claude",
          profiles: [
            {
              profileKey: "Default",
              status: "verified",
              candidate: {
                candidateId: "candidate-claude",
                provider: "Claude",
                browser: "Chrome",
                profileKey: "Default",
                host: "claude.ai",
                expiresAtMs: Date.now() + 60_000,
                identity: { email: "work@example.com" },
              },
            },
          ],
          partial: false,
        })
      }
      if (command === "perform_provider_account_operation") {
        return Promise.resolve(receipt(attachedView))
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    renderControls(
      <ProviderAccountControls
        providerId="claude"
        browserBinding
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("button", { name: "连接浏览器" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.click(await screen.findByRole("button", { name: "Main" }))
    await user.click(await screen.findByRole("button", { name: "连接所选浏览器" }))

    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))
  })
})
