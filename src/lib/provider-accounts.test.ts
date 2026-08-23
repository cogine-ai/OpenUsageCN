import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

describe("provider accounts client", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
  })

  it("loads a provider account view with a camelCase provider id", async () => {
    const view = {
      providerId: "cursor",
      selection: { mode: "auto" as const },
      activeAccountId: null,
      accounts: [],
    }
    tauri.invoke.mockResolvedValue(view)
    const { getProviderAccountView } = await import("./provider-accounts")

    await expect(getProviderAccountView("cursor")).resolves.toEqual(view)
    expect(tauri.invoke).toHaveBeenCalledWith("get_provider_account_view", {
      providerId: "cursor",
    })
  })

  it("performs a typed operation with camelCase command arguments", async () => {
    const receipt = {
      operationId: "operation-1",
      status: "succeeded" as const,
      sourceOutcomes: [],
      view: {
        providerId: "cursor",
        selection: { mode: "pinned" as const, accountId: "account-2" },
        activeAccountId: "account-2",
        accounts: [],
      },
    }
    tauri.invoke.mockResolvedValue(receipt)
    const { performProviderAccountOperation } = await import("./provider-accounts")
    const operation = { kind: "selectActive" as const, accountId: "account-2" }

    await expect(performProviderAccountOperation("cursor", operation)).resolves.toEqual(receipt)
    expect(tauri.invoke).toHaveBeenCalledWith("perform_provider_account_operation", {
      providerId: "cursor",
      operation,
    })
  })
})
