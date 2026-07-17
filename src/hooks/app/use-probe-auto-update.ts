import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react"
import {
  getEnabledPluginIds,
  type AutoUpdateIntervalMinutes,
  type PluginSettings,
} from "@/lib/settings"
import type { PluginState } from "@/hooks/app/types"

export const AUTO_UPDATE_FAILURE_BACKOFF_MS = 15 * 60_000
export const RESET_BOUNDARY_REFRESH_GRACE_MS = 30_000
export const RESET_BOUNDARY_REFRESH_MIN_DELAY_MS = 5_000
export const MAX_TRACKED_RESET_BOUNDARIES_PER_PLUGIN = 64

type ResetBoundaryCandidate = {
  pluginId: string
  boundaryAt: number
}

type ResetBoundaryRefreshPlan = {
  refreshAt: number
  candidates: ResetBoundaryCandidate[]
}

type GetResetBoundaryRefreshPlanArgs = {
  enabledIds: string[]
  pluginStates: Record<string, PluginState>
  attemptedBoundaries: ReadonlyMap<string, ReadonlySet<number>>
  nextAutoUpdateAt: number
}

export function getResetBoundaryRefreshPlan({
  enabledIds,
  pluginStates,
  attemptedBoundaries,
  nextAutoUpdateAt,
}: GetResetBoundaryRefreshPlanArgs): ResetBoundaryRefreshPlan | null {
  const candidates: Array<ResetBoundaryCandidate & { refreshAt: number }> = []

  for (const pluginId of enabledIds) {
    const lines = pluginStates[pluginId]?.data?.lines ?? []
    const seenBoundaries = new Set<number>()

    for (const line of lines) {
      if (line.type !== "progress" || !line.resetsAt) continue

      const boundaryAt = Date.parse(line.resetsAt)
      if (!Number.isFinite(boundaryAt)) continue
      if (seenBoundaries.has(boundaryAt)) continue
      seenBoundaries.add(boundaryAt)
      if (attemptedBoundaries.get(pluginId)?.has(boundaryAt)) continue
      const refreshAt = boundaryAt + RESET_BOUNDARY_REFRESH_GRACE_MS
      const lastUpdatedAt = pluginStates[pluginId]?.lastUpdatedAt
      if (lastUpdatedAt !== null && lastUpdatedAt !== undefined && lastUpdatedAt >= refreshAt) {
        continue
      }

      if (refreshAt >= nextAutoUpdateAt) continue
      candidates.push({ pluginId, boundaryAt, refreshAt })
    }
  }

  if (candidates.length === 0) return null

  const refreshAt = Math.min(...candidates.map((candidate) => candidate.refreshAt))
  return {
    refreshAt,
    candidates: candidates
      .filter((candidate) => candidate.refreshAt === refreshAt)
      .map(({ pluginId, boundaryAt }) => ({ pluginId, boundaryAt })),
  }
}

export function recordAttemptedResetBoundary(
  attemptedBoundaries: Map<string, Set<number>>,
  pluginId: string,
  boundaryAt: number
) {
  const attempted = attemptedBoundaries.get(pluginId) ?? new Set<number>()
  attempted.add(boundaryAt)

  while (attempted.size > MAX_TRACKED_RESET_BOUNDARIES_PER_PLUGIN) {
    const oldestBoundary = attempted.values().next().value
    if (oldestBoundary === undefined) break
    attempted.delete(oldestBoundary)
  }

  attemptedBoundaries.set(pluginId, attempted)
}

function getResetBoundaryScheduleSignature(
  pluginSettings: PluginSettings | null,
  pluginStates: Record<string, PluginState>
): string {
  if (!pluginSettings) return ""

  return JSON.stringify(
    getEnabledPluginIds(pluginSettings).map((pluginId) => [
      pluginId,
      (pluginStates[pluginId]?.data?.lines ?? [])
        .flatMap((line) => line.type === "progress" && line.resetsAt ? [line.resetsAt] : []),
    ])
  )
}

type UseProbeAutoUpdateArgs = {
  pluginSettings: PluginSettings | null
  autoUpdateInterval: AutoUpdateIntervalMinutes
  pluginStates: Record<string, PluginState>
  pluginStatesRef: MutableRefObject<Record<string, PluginState>>
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  isPluginLoading: (id: string) => boolean
  startBatch: (pluginIds?: string[]) => Promise<string[] | undefined>
}

export function useProbeAutoUpdate({
  pluginSettings,
  autoUpdateInterval,
  pluginStates,
  pluginStatesRef,
  setLoadingForPlugins,
  setErrorForPlugins,
  isPluginLoading,
  startBatch,
}: UseProbeAutoUpdateArgs) {
  const [autoUpdateNextAt, setAutoUpdateNextAt] = useState<number | null>(null)
  const [autoUpdateResetToken, setAutoUpdateResetToken] = useState(0)
  const [resetBoundaryScheduleToken, setResetBoundaryScheduleToken] = useState(0)
  const attemptedResetBoundariesRef = useRef<Map<string, Set<number>>>(new Map())
  const resetBoundaryScheduleSignature = getResetBoundaryScheduleSignature(
    pluginSettings,
    pluginStates
  )

  useEffect(() => {
    if (!pluginSettings) {
      setAutoUpdateNextAt(null)
      return
    }

    const enabledIds = getEnabledPluginIds(pluginSettings)
    if (enabledIds.length === 0) {
      setAutoUpdateNextAt(null)
      return
    }

    const intervalMs = autoUpdateInterval * 60_000
    const scheduleNext = () => setAutoUpdateNextAt(Date.now() + intervalMs)
    scheduleNext()

    const interval = setInterval(() => {
      const now = Date.now()
      const idleIds = enabledIds.filter((id) => {
        if (isPluginLoading(id)) return false
        const currentState = pluginStatesRef.current[id]
        if (!currentState?.error || !currentState.lastErrorAt) return true
        return now - currentState.lastErrorAt >= AUTO_UPDATE_FAILURE_BACKOFF_MS
      })
      if (idleIds.length === 0) {
        scheduleNext()
        return
      }

      setLoadingForPlugins(idleIds)
      startBatch(idleIds).catch((error) => {
        console.error("Failed to start auto-update batch:", error)
        setErrorForPlugins(idleIds, "无法开始刷新")
      })
      scheduleNext()
    }, intervalMs)

    return () => clearInterval(interval)
  }, [
    autoUpdateInterval,
    autoUpdateResetToken,
    pluginSettings,
    pluginStatesRef,
    isPluginLoading,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
  ])

  useEffect(() => {
    if (!pluginSettings || autoUpdateNextAt === null) return

    const enabledIds = getEnabledPluginIds(pluginSettings)
    const plan = getResetBoundaryRefreshPlan({
      enabledIds,
      pluginStates: pluginStatesRef.current,
      attemptedBoundaries: attemptedResetBoundariesRef.current,
      nextAutoUpdateAt: autoUpdateNextAt,
    })
    if (!plan) return

    const now = Date.now()
    const delayMs = plan.refreshAt <= now
      ? RESET_BOUNDARY_REFRESH_MIN_DELAY_MS
      : plan.refreshAt - now
    const timeout = setTimeout(() => {
      const now = Date.now()
      const eligibleCandidates = plan.candidates.filter((candidate) => {
        if (isPluginLoading(candidate.pluginId)) return false
        const currentState = pluginStatesRef.current[candidate.pluginId]
        const refreshAt = candidate.boundaryAt + RESET_BOUNDARY_REFRESH_GRACE_MS
        if (
          currentState?.lastUpdatedAt !== null &&
          currentState?.lastUpdatedAt !== undefined &&
          currentState.lastUpdatedAt >= refreshAt
        ) {
          return false
        }
        if (!currentState?.error || !currentState.lastErrorAt) return true
        return now - currentState.lastErrorAt >= AUTO_UPDATE_FAILURE_BACKOFF_MS
      })
      const eligibleIds = eligibleCandidates.map((candidate) => candidate.pluginId)

      if (eligibleIds.length > 0) {
        setLoadingForPlugins(eligibleIds)
        startBatch(eligibleIds)
          .then(() => {
            // Only consume the boundary after the batch actually starts.
            // A rejected startBatch must remain retryable after backoff.
            for (const candidate of eligibleCandidates) {
              recordAttemptedResetBoundary(
                attemptedResetBoundariesRef.current,
                candidate.pluginId,
                candidate.boundaryAt
              )
            }
          })
          .catch((error) => {
            console.error("Failed to start reset-boundary refresh batch:", error)
            setErrorForPlugins(eligibleIds, "无法开始刷新")
          })
      }

      setResetBoundaryScheduleToken((value) => value + 1)
    }, delayMs)

    return () => clearTimeout(timeout)
  }, [
    autoUpdateNextAt,
    pluginSettings,
    pluginStatesRef,
    resetBoundaryScheduleSignature,
    resetBoundaryScheduleToken,
    isPluginLoading,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
  ])

  const resetAutoUpdateSchedule = useCallback(() => {
    if (!pluginSettings) return
    const enabledIds = getEnabledPluginIds(pluginSettings)
    /* v8 ignore start */
    if (enabledIds.length === 0) {
      setAutoUpdateNextAt(null)
      return
    }
    /* v8 ignore stop */

    setAutoUpdateNextAt(Date.now() + autoUpdateInterval * 60_000)
    setAutoUpdateResetToken((value) => value + 1)
  }, [autoUpdateInterval, pluginSettings])

  return {
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    resetAutoUpdateSchedule,
  }
}
