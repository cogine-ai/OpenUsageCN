import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { useProbeRefreshActions } from "@/hooks/app/use-probe-refresh-actions"
import { useProbeState } from "@/hooks/app/use-probe-state"
import type { StartBatch } from "@/hooks/use-probe-events"

function AccountTransitionHarness({ startBatch }: { startBatch: StartBatch }) {
  const probeState = useProbeState({})
  const { handleAccountChangeRefresh } = useProbeRefreshActions({
    pluginSettings: { order: ["codex"], disabled: [] },
    pluginStatesRef: probeState.pluginStatesRef,
    resetAutoUpdateSchedule: vi.fn(),
    setLoadingForPlugins: probeState.setLoadingForPlugins,
    setAccountTransitionForPlugins: probeState.setAccountTransitionForPlugins,
    setErrorForPlugins: probeState.setErrorForPlugins,
    startBatch,
  })
  const state = probeState.pluginStates.codex
  const line = state?.data?.lines[0]

  return (
    <>
      <button
        type="button"
        onClick={() =>
          probeState.handleProbeResult(
            {
              providerId: "codex",
              displayName: "Codex",
              iconUrl: "",
              lines: [{ type: "text", label: "Usage", value: "Old Account A" }],
            },
            { manual: false }
          )
        }
      >
        Seed Old Account
      </button>
      <button type="button" onClick={() => handleAccountChangeRefresh("codex")}>
        Change Account
      </button>
      {line?.type === "text" ? <p>{line.value}</p> : null}
      {state?.loading ? <p>Loading New Account</p> : null}
      {state?.error ? <p>{state.error}</p> : null}
    </>
  )
}

it("removes old account data immediately and ends loading after start failure", async () => {
  let rejectStart!: (error: Error) => void
  const startBatch = vi.fn(
    () =>
      new Promise<string[]>((_resolve, reject) => {
        rejectStart = reject
      })
  )
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  const user = userEvent.setup()
  render(<AccountTransitionHarness startBatch={startBatch} />)

  await user.click(screen.getByRole("button", { name: "Seed Old Account" }))
  expect(screen.getByText("Old Account A")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Change Account" }))
  expect(screen.queryByText("Old Account A")).not.toBeInTheDocument()
  expect(screen.getByText("Loading New Account")).toBeInTheDocument()
  expect(startBatch).toHaveBeenCalledWith(["codex"], {
    invalidatePreviousOnFailure: true,
  })

  await act(async () => rejectStart(new Error("batch failed")))

  expect(await screen.findByText("无法开始刷新")).toBeInTheDocument()
  expect(screen.queryByText("Loading New Account")).not.toBeInTheDocument()
  expect(errorSpy).toHaveBeenCalled()
})
