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

import { ProviderDetailPage } from "@/pages/provider-detail"

describe("ProviderDetailPage", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listen.mockResolvedValue(vi.fn())
  })

  it("shows not found when plugin missing", () => {
    render(<ProviderDetailPage plugin={null} displayMode="used" resetTimerDisplayMode="relative" />)
    expect(screen.getByText("未找到服务商")).toBeInTheDocument()
  })

  it("renders ProviderCard with all scope when plugin present", async () => {
    render(
      <ProviderDetailPage
        displayMode="used"
        resetTimerDisplayMode="relative"
        plugin={{
          meta: { id: "a", name: "Alpha", iconUrl: "", lines: [] },
          data: { providerId: "a", displayName: "Alpha", iconUrl: "", lines: [] },
          loading: false,
          error: null,
          lastManualRefreshAt: null,
          lastUpdatedAt: null,
        }}
      />
    )
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0)
  })

  it("renders when plugin data is null (still shows provider name)", () => {
    render(
      <ProviderDetailPage
        displayMode="used"
        resetTimerDisplayMode="relative"
        plugin={{
          meta: { id: "a", name: "Alpha", iconUrl: "", lines: [] },
          data: null,
          loading: false,
          error: null,
          lastManualRefreshAt: null,
          lastUpdatedAt: null,
        }}
      />
    )
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0)
    expect(screen.queryByRole("heading", { name: "Provider Accounts" })).not.toBeInTheDocument()
  })

  it("renders quick links when provided by plugin meta", () => {
    render(
      <ProviderDetailPage
        displayMode="used"
        resetTimerDisplayMode="relative"
        plugin={{
          meta: {
            id: "a",
            name: "Alpha",
            iconUrl: "",
            lines: [],
            links: [{ label: "Status", url: "https://status.example.com" }],
          },
          data: null,
          loading: false,
          error: null,
          lastManualRefreshAt: null,
          lastUpdatedAt: null,
        }}
      />
    )
    expect(screen.getByRole("button", { name: /status/i })).toBeInTheDocument()
  })

  it("shows account controls and active-account model history for Cursor detail", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_provider_account_view") {
        return Promise.resolve({
          providerId: "cursor",
          selection: { mode: "auto" },
          activeAccountId: "account-1",
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
      <ProviderDetailPage
        displayMode="used"
        resetTimerDisplayMode="relative"
        plugin={{
          meta: {
            id: "cursor",
            name: "Cursor",
            iconUrl: "",
            lines: [],
            accountSupport: {
              localDiscovery: true,
              browserBinding: true,
              modelHistory: true,
            },
          },
          data: null,
          loading: false,
          error: null,
          lastManualRefreshAt: null,
          lastUpdatedAt: null,
        }}
      />
    )

    expect(
      await screen.findByRole("heading", { name: "Provider Accounts" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add Browser Account" })).toBeInTheDocument()
    expect(await screen.findByRole("heading", { name: "Model Usage" })).toBeInTheDocument()
  })

  it("refreshes the provider quota after the active account changes", async () => {
    const initialView = {
      providerId: "cursor",
      selection: { mode: "pinned", accountId: "account-1" },
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
        {
          accountId: "account-2",
          label: "Personal",
          connectionKinds: ["desktop"],
          connections: [],
          selected: false,
          stale: false,
        },
      ],
    }
    tauri.invoke
      .mockResolvedValueOnce(initialView)
      .mockResolvedValueOnce({
        operationId: "operation-select",
        status: "succeeded",
        sourceOutcomes: [],
        view: {
          ...initialView,
          selection: { mode: "pinned", accountId: "account-2" },
          activeAccountId: "account-2",
        },
      })
    const onRetry = vi.fn()
    const onAccountChangeRefresh = vi.fn()
    const user = userEvent.setup()

    render(
      <ProviderDetailPage
        displayMode="used"
        resetTimerDisplayMode="relative"
        onRetry={onRetry}
        onAccountChangeRefresh={onAccountChangeRefresh}
        plugin={{
          meta: {
            id: "cursor",
            name: "Cursor",
            iconUrl: "",
            lines: [],
            accountSupport: {
              localDiscovery: true,
              browserBinding: false,
              modelHistory: false,
            },
          },
          data: null,
          loading: false,
          error: null,
          lastManualRefreshAt: null,
          lastUpdatedAt: null,
        }}
      />
    )

    await user.click(await screen.findByRole("radio", { name: /Personal/i }))

    await waitFor(() => expect(onAccountChangeRefresh).toHaveBeenCalledTimes(1))
    expect(onRetry).not.toHaveBeenCalled()
  })
})
