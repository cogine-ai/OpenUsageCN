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
    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Chrome" }))
    expect(screen.getByRole("status")).toHaveTextContent("Loading Browser Profiles")
    await user.click(screen.getByRole("button", { name: "Close Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Add Browser Account" }))
    await user.click(screen.getByRole("button", { name: "Arc" }))
    expect(await screen.findByRole("option", { name: "Arc Main (Default)" })).toBeInTheDocument()

    await act(async () => {
      resolveChrome({
        profiles: [{ profileKey: "Profile 2", displayName: "Chrome Work" }],
      })
      await chromeRequest
    })

    expect(screen.getByRole("option", { name: "Arc Main (Default)" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Chrome Work (Profile 2)" })).toBeNull()
  })
})
