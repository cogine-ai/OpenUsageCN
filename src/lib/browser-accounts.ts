import { invoke } from "@tauri-apps/api/core"

export type BrowserName = "Chrome" | "Arc"
export type BrowserAccountProviderId = "cursor" | "claude"
export type BrowserAccountProvider = "Cursor" | "Claude"

export type BrowserProfile = {
  profileKey: string
  displayName: string
}

export type BrowserProfileList = {
  profiles: BrowserProfile[]
}

export type BrowserAccountError = {
  code: string
  message: string
}

export type BrowserAccountCandidate = {
  candidateId: string
  provider: BrowserAccountProvider
  browser: BrowserName
  profileKey: string
  host: string
  expiresAtMs: number
}

export type BrowserProfileDiscovery = {
  profileKey: string
  status: "verified" | "empty" | "failed"
  candidate?: BrowserAccountCandidate
  error?: BrowserAccountError
}

export type BrowserAccountDiscovery = {
  browser: BrowserName
  provider: BrowserAccountProvider
  profiles: BrowserProfileDiscovery[]
  partial: boolean
}

export type DiscoverBrowserAccountsInput = {
  requestId: string
  providerId: BrowserAccountProviderId
  browser: BrowserName
  profileKey?: string
}

export function listBrowserProfiles(browser: BrowserName): Promise<BrowserProfileList> {
  return invoke<BrowserProfileList>("list_browser_profiles", { browser })
}

export function discoverBrowserAccounts(
  input: DiscoverBrowserAccountsInput
): Promise<BrowserAccountDiscovery> {
  const args = input.profileKey
    ? { ...input, profileKey: input.profileKey }
    : {
        requestId: input.requestId,
        providerId: input.providerId,
        browser: input.browser,
      }
  return invoke<BrowserAccountDiscovery>("discover_browser_accounts", args)
}

export function cancelBrowserDiscovery(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_browser_discovery", { requestId })
}
