import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listener: null as null | ((event: { payload: unknown }) => void),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}))

import { ProviderAccountControls } from "@/components/provider-account-controls"

function accountView() {
  return {
    providerId: "cursor",
    selection: { mode: "pinned" as const, accountId: "account-1" },
    activeAccountId: "account-1",
    accounts: [],
  }
}

function history() {
  return {
    accountId: "account-1",
    buckets: [
      {
        localDate: "2026-08-24",
        modelName: "composer-1.5",
        inputTokens: 100,
        outputTokens: 20,
        cacheWriteTokens: 0,
        cacheReadTokens: 10,
        requestCount: 1,
        knownListCostUsd: 0.2,
        listCostCoverage: "complete" as const,
      },
    ],
    coverage: {
      fromMs: 1_787_400_000_000,
      toMs: 1_787_500_000_000,
      fetchedAtMs: 1_787_500_000_000,
      timeZone: "Asia/Taipei",
      complete: true,
      scope: "sessionVisible" as const,
    },
    totals: {
      meteredChargedUsd: 0.2,
      meteredCoverage: "complete" as const,
    },
  }
}

describe("ProviderAccountControls history revision demand", () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    tauri.listener = null
    tauri.listen.mockImplementation(
      async (_eventName: string, listener: (event: { payload: unknown }) => void) => {
        tauri.listener = listener
        return vi.fn()
      }
    )
  })

  it("retries Cursor history when account enrichment keeps the same active id", async () => {
    const fresh = history()
    let historyRefreshes = 0
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "get_provider_account_view") return Promise.resolve(accountView())
      if (command === "get_cursor_history_snapshot") return Promise.resolve(null)
      if (command === "refresh_cursor_history") {
        historyRefreshes += 1
        return Promise.resolve(
          historyRefreshes === 1
            ? {
                snapshot: null,
                stale: false,
                error: {
                  code: "connectionUnavailable",
                  message: "Cursor account connection is unavailable.",
                },
              }
            : { snapshot: fresh, stale: false }
        )
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    render(
      <ProviderAccountControls
        providerId="cursor"
        modelHistory
      />
    )

    expect(
      await screen.findByRole("heading", { name: "Model Usage Error" })
    ).toBeInTheDocument()
    expect(historyRefreshes).toBe(1)
    await waitFor(() => expect(tauri.listener).not.toBeNull())

    act(() => {
      tauri.listener?.({ payload: { providerId: "cursor", revision: 11 } })
    })

    await waitFor(() => expect(historyRefreshes).toBe(2))
    expect(await screen.findByText("composer-1.5")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Model Usage Error" })).not.toBeInTheDocument()
  })
})
