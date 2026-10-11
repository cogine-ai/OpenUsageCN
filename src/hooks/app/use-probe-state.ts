import { useCallback, useEffect, useRef, useState } from "react"
import type { PluginOutput } from "@/lib/plugin-types"
import type { PluginState } from "@/hooks/app/types"
import type { ProbeResultContext } from "@/hooks/use-probe-events"
import { probeFailure } from "@/lib/probe-failure"

type UseProbeStateArgs = {
  onProbeResult?: () => void
}

/** Track current checks while retaining the last successful quota and its actual freshness. */
export function useProbeState({ onProbeResult }: UseProbeStateArgs) {
  const [pluginStates, setPluginStates] = useState<Record<string, PluginState>>({})

  const pluginStatesRef = useRef(pluginStates)
  useEffect(() => {
    pluginStatesRef.current = pluginStates
  }, [pluginStates])

  /** Update the shared ref synchronously so queued events observe the same state as the next render. */
  const updatePluginStates = useCallback(
    (
      updater: (
        previousStates: Record<string, PluginState>
      ) => Record<string, PluginState>
    ) => {
      const nextStates = updater(pluginStatesRef.current)
      pluginStatesRef.current = nextStates
      setPluginStates(nextStates)
    },
    []
  )

  /** Mark refreshes pending without discarding the existing quota or its success timestamp. */
  const setLoadingForPlugins = useCallback((ids: string[]) => {
    updatePluginStates((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        const existing = prev[id]
        next[id] = {
          data: existing?.data ?? null,
          loading: true,
          error: null,
          lastErrorAt: null,
          lastManualRefreshAt: existing?.lastManualRefreshAt ?? null,
          lastUpdatedAt: existing?.lastUpdatedAt ?? null,
        }
      }
      return next
    })
  }, [updatePluginStates])

  /** Clear the previous account's quota before a replacement account is checked. */
  const setAccountTransitionForPlugins = useCallback((ids: string[]) => {
    updatePluginStates((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        const existing = prev[id]
        next[id] = {
          data: null,
          loading: true,
          error: null,
          lastErrorAt: null,
          lastManualRefreshAt: existing?.lastManualRefreshAt ?? null,
          lastUpdatedAt: null,
        }
      }
      return next
    })
  }, [updatePluginStates])

  /** Record a failed check while preserving previously retrieved data and successful refresh times. */
  const setErrorForPlugins = useCallback((ids: string[], error: string) => {
    const now = Date.now()
    updatePluginStates((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        const existing = prev[id]
        next[id] = {
          data: existing?.data ?? null,
          loading: false,
          error,
          lastErrorAt: now,
          lastManualRefreshAt: existing?.lastManualRefreshAt ?? null,
          lastUpdatedAt: existing?.lastUpdatedAt ?? null,
        }
      }
      return next
    })
  }, [updatePluginStates])

  /** Distinguish real success from errors and cached Claude rate-limit data when recording freshness. */
  const handleProbeResult = useCallback(
    (output: PluginOutput, { manual }: ProbeResultContext) => {
      const errorMessage = probeFailure(output)

      const now = Date.now()
      updatePluginStates((prev) => {
        const existing = prev[output.providerId]
        return {
          ...prev,
          [output.providerId]: {
            data: errorMessage ? (existing?.data ?? (output.providerId === "claude" && output.lines.some((line) => line.type === "progress") ? output : null)) : output,
            loading: false,
            error: errorMessage,
            lastErrorAt: errorMessage ? now : null,
            lastManualRefreshAt: !errorMessage && manual
              ? now
              : existing?.lastManualRefreshAt ?? null,
            lastUpdatedAt: errorMessage ? (existing?.lastUpdatedAt ?? null) : now,
          },
        }
      })

      onProbeResult?.()
    },
    [onProbeResult, updatePluginStates]
  )

  return {
    pluginStates,
    pluginStatesRef,
    setLoadingForPlugins,
    setAccountTransitionForPlugins,
    setErrorForPlugins,
    handleProbeResult,
  }
}
