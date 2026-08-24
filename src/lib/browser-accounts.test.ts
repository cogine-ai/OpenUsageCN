import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

describe("browser accounts client", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
  })

  it("lists profile metadata for the explicitly selected browser", async () => {
    const response = {
      profiles: [{ profileKey: "Default", displayName: "Person 1" }],
    }
    tauri.invoke.mockResolvedValue(response)
    const { listBrowserProfiles } = await import("./browser-accounts")

    await expect(listBrowserProfiles("Chrome")).resolves.toEqual(response)
    expect(tauri.invoke).toHaveBeenCalledWith("list_browser_profiles", {
      browser: "Chrome",
    })
  })

  it("discovers one exact Cursor profile with camelCase arguments", async () => {
    const response = {
      browser: "Arc",
      provider: "Cursor",
      profiles: [{ profileKey: "Default", status: "empty" }],
      partial: false,
    }
    tauri.invoke.mockResolvedValue(response)
    const { discoverBrowserAccounts } = await import("./browser-accounts")

    await expect(
      discoverBrowserAccounts({
        requestId: "request-1",
        providerId: "cursor",
        browser: "Arc",
        profileKey: "Default",
      })
    ).resolves.toEqual(response)
    expect(tauri.invoke).toHaveBeenCalledWith("discover_browser_accounts", {
      requestId: "request-1",
      providerId: "cursor",
      browser: "Arc",
      profileKey: "Default",
    })
  })

  it("omits profileKey for an explicit All Profiles discovery", async () => {
    tauri.invoke.mockResolvedValue({
      browser: "Chrome",
      provider: "Cursor",
      profiles: [],
      partial: false,
    })
    const { discoverBrowserAccounts } = await import("./browser-accounts")

    await discoverBrowserAccounts({
      requestId: "request-all",
      providerId: "cursor",
      browser: "Chrome",
    })

    expect(tauri.invoke).toHaveBeenCalledWith("discover_browser_accounts", {
      requestId: "request-all",
      providerId: "cursor",
      browser: "Chrome",
    })
  })

  it("discovers one exact Claude profile with the same nonsecret contract", async () => {
    tauri.invoke.mockResolvedValue({
      browser: "Chrome",
      provider: "Claude",
      profiles: [{ profileKey: "Profile 2", status: "empty" }],
      partial: false,
    })
    const { discoverBrowserAccounts } = await import("./browser-accounts")

    await discoverBrowserAccounts({
      requestId: "request-claude",
      providerId: "claude",
      browser: "Chrome",
      profileKey: "Profile 2",
    })

    expect(tauri.invoke).toHaveBeenCalledWith("discover_browser_accounts", {
      requestId: "request-claude",
      providerId: "claude",
      browser: "Chrome",
      profileKey: "Profile 2",
    })
  })

  it("cancels the active discovery by request id", async () => {
    tauri.invoke.mockResolvedValue(true)
    const { cancelBrowserDiscovery } = await import("./browser-accounts")

    await expect(cancelBrowserDiscovery("request-2")).resolves.toBe(true)
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_browser_discovery", {
      requestId: "request-2",
    })
  })
})
