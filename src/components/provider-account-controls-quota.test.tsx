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

    render(
      <ProviderAccountControls
        providerId="cursor"
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("radio", { name: /Personal/i }))
    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole("radio", { name: /自动跟随/i }))
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

    render(
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

    render(
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

    render(
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

    render(
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
                expiresAtMs: 1_787_500_000_000,
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

    render(
      <ProviderAccountControls
        providerId="cursor"
        browserBinding
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))
    await user.click(await screen.findByRole("button", { name: "Attach Main" }))

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
                expiresAtMs: 1_787_500_000_000,
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

    render(
      <ProviderAccountControls
        providerId="claude"
        browserBinding
        onAccountChangeRefresh={onAccountChangeRefresh}
      />
    )

    await user.click(await screen.findByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))
    await user.click(await screen.findByRole("button", { name: "Attach Main" }))

    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))
  })
})
