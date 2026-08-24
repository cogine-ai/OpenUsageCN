import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

import { BrowserAccountManager } from "@/components/browser-account-manager"

describe("BrowserAccountManager errors", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
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
