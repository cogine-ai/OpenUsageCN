import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginState } from "@/hooks/app/types"
import type { PluginMeta } from "@/lib/plugin-types"

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

import { usePaceNotifications } from "@/hooks/app/use-pace-notifications"

const now = Date.parse("2026-07-14T02:00:00Z")
const plugin: PluginMeta = {
  id: "codex",
  name: "Codex",
  iconUrl: "",
  lines: [],
  primaryCandidates: [],
}
const settings = { almostOut: true, closeToLimit: true, runningOut: true }

function state(used: number, revision: number): PluginState {
  return {
    data: {
      providerId: "codex",
      displayName: "Codex",
      iconUrl: "",
      lines: [
        {
          type: "progress",
          label: "Session",
          used,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: new Date(now + 5 * 3_600_000).toISOString(),
          periodDurationMs: 10 * 3_600_000,
        },
      ],
    },
    loading: false,
    error: null,
    lastManualRefreshAt: null,
    lastUpdatedAt: revision,
  }
}

describe("usePaceNotifications", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    isTauriMock.mockReturnValue(true)
    vi.spyOn(Date, "now").mockReturnValue(now)
  })

  it("primes on first data, posts a worsening edge, and skips disabled providers", async () => {
    const { rerender } = renderHook(
      ({ used, revision, disabled }) =>
        usePaceNotifications({
          pluginsMeta: [plugin],
          pluginSettings: { order: ["codex"], disabled: disabled ? ["codex"] : [] },
          pluginStates: { codex: state(used, revision) },
          settings,
        }),
      { initialProps: { used: 30, revision: 1, disabled: false } }
    )

    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled())
    rerender({ used: 45, revision: 2, disabled: false })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("post_pace_notification", {
        title: "接近上限",
        subtitle: "Codex · Session",
        body: "按当前速度，预计将在重置前接近额度上限。",
      })
    })

    rerender({ used: 60, revision: 3, disabled: true })
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
  })

  it("keeps paced state when an earlier progress line is inserted", async () => {
    const sessionLine = {
      type: "progress" as const,
      label: "Session",
      used: 30,
      limit: 100,
      format: { kind: "percent" as const },
      resetsAt: new Date(now + 5 * 3_600_000).toISOString(),
      periodDurationMs: 10 * 3_600_000,
    }
    const bonusLine = {
      type: "progress" as const,
      label: "Bonus spend",
      used: 1,
      limit: 10,
      format: { kind: "dollars" as const },
      resetsAt: new Date(now + 5 * 3_600_000).toISOString(),
      periodDurationMs: 10 * 3_600_000,
    }

    function multiState(
      lines: NonNullable<PluginState["data"]>["lines"],
      revision: number
    ): PluginState {
      return {
        data: {
          providerId: "cursor",
          displayName: "Cursor",
          iconUrl: "",
          lines,
        },
        loading: false,
        error: null,
        lastManualRefreshAt: null,
        lastUpdatedAt: revision,
      }
    }

    const cursorPlugin: PluginMeta = {
      ...plugin,
      id: "cursor",
      name: "Cursor",
    }

    const { rerender } = renderHook(
      ({ lines, revision }) =>
        usePaceNotifications({
          pluginsMeta: [cursorPlugin],
          pluginSettings: { order: ["cursor"], disabled: [] },
          pluginStates: { cursor: multiState(lines, revision) },
          settings,
        }),
      {
        initialProps: {
          lines: [sessionLine],
          revision: 1,
        },
      }
    )

    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled())

    // Insert Bonus spend ahead of Session; paced Session state must survive.
    rerender({
      lines: [bonusLine, { ...sessionLine, used: 45 }],
      revision: 2,
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("post_pace_notification", {
        title: "接近上限",
        subtitle: "Cursor · Session",
        body: "按当前速度，预计将在重置前接近额度上限。",
      })
    })
  })
})
