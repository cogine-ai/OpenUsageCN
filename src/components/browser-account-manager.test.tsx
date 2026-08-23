import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

import { BrowserAccountManager } from "@/components/browser-account-manager"

describe("BrowserAccountManager", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
  })

  it("lists metadata only after the user chooses Chrome", async () => {
    tauri.invoke.mockResolvedValue({
      profiles: [{ profileKey: "Profile 2", displayName: "Work" }],
    })
    const user = userEvent.setup()

    render(
      <BrowserAccountManager
        busy={false}
        onAttach={vi.fn()}
      />
    )

    expect(tauri.invoke).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    expect(tauri.invoke).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Chrome" }))

    expect(await screen.findByRole("option", { name: "Work (Profile 2)" })).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledWith("list_browser_profiles", {
      browser: "Chrome",
    })
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it("loads profile metadata inside the app's React StrictMode", async () => {
    tauri.invoke.mockResolvedValue({
      profiles: [{ profileKey: "Default", displayName: "Main" }],
    })
    const user = userEvent.setup()

    render(
      <StrictMode>
        <BrowserAccountManager busy={false} onAttach={vi.fn()} />
      </StrictMode>
    )

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))

    expect(await screen.findByRole("option", { name: "Main (Default)" })).toBeInTheDocument()
  })

  it("discovers and attaches one explicitly selected profile", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Profile 2", displayName: "Work" }],
        })
      }
      if (command === "discover_browser_accounts") {
        return Promise.resolve({
          browser: "Chrome",
          provider: "Cursor",
          profiles: [
            {
              profileKey: "Profile 2",
              status: "verified",
              candidate: {
                candidateId: "candidate-1",
                provider: "Cursor",
                browser: "Chrome",
                profileKey: "Profile 2",
                host: "cursor.com",
                expiresAtMs: 1_787_500_000_000,
              },
            },
          ],
          partial: false,
        })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const onAttach = vi.fn().mockResolvedValue({
      operationId: "operation-1",
      status: "succeeded",
      sourceOutcomes: [],
      view: {
        providerId: "cursor",
        selection: { mode: "pinned", accountId: "account-1" },
        activeAccountId: "account-1",
        accounts: [],
      },
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={onAttach} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Profile 2"
    )
    expect(tauri.invoke).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "Scan Profile" }))

    expect(await screen.findByText("Verified")).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenLastCalledWith(
      "discover_browser_accounts",
      expect.objectContaining({
        providerId: "cursor",
        browser: "Chrome",
        profileKey: "Profile 2",
        requestId: expect.any(String),
      })
    )

    await user.click(screen.getByRole("button", { name: "Attach Work" }))

    expect(onAttach).toHaveBeenCalledWith("candidate-1")
    expect(screen.getByRole("button", { name: "Add Browser Account" })).toBeInTheDocument()
  })

  it("requires one exact profile for Claude discovery", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Profile 2", displayName: "Work" }],
        })
      }
      if (command === "discover_browser_accounts") {
        return Promise.resolve({
          browser: "Chrome",
          provider: "Claude",
          profiles: [{ profileKey: "Profile 2", status: "empty" }],
          partial: false,
        })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    render(
      <BrowserAccountManager
        busy={false}
        providerId="claude"
        onAttach={vi.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    const profile = await screen.findByRole("combobox", { name: "Browser Profile" })
    expect(screen.queryByRole("option", { name: "All Profiles" })).not.toBeInTheDocument()
    await user.selectOptions(profile, "Profile 2")
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))

    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", {
      requestId: expect.any(String),
      providerId: "claude",
      browser: "Chrome",
      profileKey: "Profile 2",
    })
  })

  it("shows every per-profile result from an explicit All Profiles scan", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [
            { profileKey: "Default", displayName: "Main" },
            { profileKey: "Profile 2", displayName: "Work" },
            { profileKey: "Profile 3", displayName: "Old" },
          ],
        })
      }
      if (command === "discover_browser_accounts") {
        return Promise.resolve({
          browser: "Arc",
          provider: "Cursor",
          profiles: [
            {
              profileKey: "Default",
              status: "verified",
              candidate: {
                candidateId: "candidate-main",
                provider: "Cursor",
                browser: "Arc",
                profileKey: "Default",
                host: "cursor.com",
                expiresAtMs: 1_787_500_000_000,
              },
            },
            { profileKey: "Profile 2", status: "empty" },
            {
              profileKey: "Profile 3",
              status: "failed",
              error: {
                code: "cookieReadFailed",
                message: "Browser cookies could not be read.",
              },
            },
          ],
          partial: true,
        })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Arc" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "all"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profiles" }))

    expect(
      await screen.findByRole("heading", { name: "Browser Discovery Partial" })
    ).toBeInTheDocument()
    expect(screen.getByText("Verified")).toBeInTheDocument()
    expect(screen.getByText("No Account")).toBeInTheDocument()
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.getByText("Browser cookies could not be read.")).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenLastCalledWith("discover_browser_accounts", {
      requestId: expect.any(String),
      providerId: "cursor",
      browser: "Arc",
    })
  })

  it("cancels an in-flight discovery when the manager unmounts", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Default", displayName: "Main" }],
        })
      }
      if (command === "discover_browser_accounts") return new Promise(() => {})
      if (command === "cancel_browser_discovery") return Promise.resolve(true)
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    const { unmount } = render(
      <BrowserAccountManager busy={false} onAttach={vi.fn()} />
    )

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))
    const discoveryCall = tauri.invoke.mock.calls.find(
      ([command]) => command === "discover_browser_accounts"
    )
    expect(discoveryCall).toBeDefined()

    unmount()

    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", {
      requestId: discoveryCall?.[1].requestId,
    })
  })

  it("cancels and closes an in-flight Add Browser Account flow", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Default", displayName: "Main" }],
        })
      }
      if (command === "discover_browser_accounts") return new Promise(() => {})
      if (command === "cancel_browser_discovery") return Promise.resolve(true)
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))
    const discoveryCall = tauri.invoke.mock.calls.find(
      ([command]) => command === "discover_browser_accounts"
    )

    await user.click(screen.getByRole("button", { name: "Close Add Browser Account" }))

    expect(screen.getByRole("button", { name: "Add Browser Account" })).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", {
      requestId: discoveryCall?.[1].requestId,
    })
  })

  it("cancels the previous request and ignores its result when scanning again", async () => {
    let resolveFirst!: (value: unknown) => void
    const firstDiscovery = new Promise((resolve) => {
      resolveFirst = resolve
    })
    let discoveryCount = 0
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Default", displayName: "Main" }],
        })
      }
      if (command === "discover_browser_accounts") {
        discoveryCount += 1
        if (discoveryCount === 1) return firstDiscovery
        return Promise.resolve({
          browser: "Chrome",
          provider: "Cursor",
          profiles: [{ profileKey: "Default", status: "empty" }],
          partial: false,
        })
      }
      if (command === "cancel_browser_discovery") return Promise.resolve(true)
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))
    const firstCall = tauri.invoke.mock.calls.find(
      ([command]) => command === "discover_browser_accounts"
    )

    await user.click(screen.getByRole("button", { name: "Scan Again" }))

    expect(await screen.findByText("No Account")).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", {
      requestId: firstCall?.[1].requestId,
    })
    expect(discoveryCount).toBe(2)

    await act(async () => {
      resolveFirst({
        browser: "Chrome",
        provider: "Cursor",
        profiles: [
          {
            profileKey: "Default",
            status: "verified",
            candidate: {
              candidateId: "old-candidate",
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
      await firstDiscovery
    })

    expect(screen.getByText("No Account")).toBeInTheDocument()
    expect(screen.queryByText("Verified")).not.toBeInTheDocument()
  })

  it("cancels the active scan when the user switches browsers", async () => {
    let resolveDiscovery!: (value: unknown) => void
    const pendingDiscovery = new Promise((resolve) => {
      resolveDiscovery = resolve
    })
    tauri.invoke.mockImplementation((command: string, args: { browser?: string }) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles:
            args.browser === "Chrome"
              ? [{ profileKey: "Default", displayName: "Chrome Main" }]
              : [{ profileKey: "Default", displayName: "Arc Main" }],
        })
      }
      if (command === "discover_browser_accounts") return pendingDiscovery
      if (command === "cancel_browser_discovery") return Promise.resolve(true)
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))
    const discoveryCall = tauri.invoke.mock.calls.find(
      ([command]) => command === "discover_browser_accounts"
    )

    await user.click(screen.getByRole("button", { name: "Arc" }))

    expect(await screen.findByRole("option", { name: "Arc Main (Default)" })).toBeInTheDocument()
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", {
      requestId: discoveryCall?.[1].requestId,
    })

    await act(async () => {
      resolveDiscovery({
        browser: "Chrome",
        provider: "Cursor",
        profiles: [
          {
            profileKey: "Default",
            status: "verified",
            candidate: {
              candidateId: "old-candidate",
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
      await pendingDiscovery
    })
    expect(screen.queryByText("Verified")).not.toBeInTheDocument()
  })

  it("shows a friendly profile-list error and logs the typed failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockRejectedValue({
      code: "profileDiscoveryFailed",
      message: "Browser profiles could not be listed.",
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))

    expect(
      await screen.findByRole("heading", { name: "Browser Profiles Unavailable" })
    ).toBeInTheDocument()
    expect(screen.getByText("Browser profiles could not be listed.")).toBeInTheDocument()
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to list browser profiles",
      "profileDiscoveryFailed"
    )
  })

  it("shows and logs a friendly account-discovery error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "list_browser_profiles") {
        return Promise.resolve({
          profiles: [{ profileKey: "Default", displayName: "Main" }],
        })
      }
      if (command === "discover_browser_accounts") {
        return Promise.reject({
          code: "overallTimedOut",
          message: "Browser profile discovery timed out.",
        })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const user = userEvent.setup()
    render(<BrowserAccountManager busy={false} onAttach={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Browser Profile" }),
      "Default"
    )
    await user.click(screen.getByRole("button", { name: "Scan Profile" }))

    expect(
      await screen.findByRole("heading", { name: "Browser Discovery Error" })
    ).toBeInTheDocument()
    expect(screen.getByText("Browser profile discovery timed out.")).toBeInTheDocument()
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to discover browser accounts",
      "overallTimedOut"
    )
  })
})
