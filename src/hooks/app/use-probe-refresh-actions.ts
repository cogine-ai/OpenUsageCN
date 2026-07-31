import { useCallback } from "react"
import type { MutableRefObject } from "react"
import { REFRESH_COOLDOWN_MS, getEnabledPluginIds, type PluginSettings } from "@/lib/settings"
import type { PluginState } from "@/hooks/app/types"
import {
  getProbeBatchStartFailedPluginIds,
  type StartBatch,
} from "@/hooks/use-probe-events"

type UseProbeRefreshActionsArgs = {
  pluginSettings: PluginSettings | null
  pluginStatesRef: MutableRefObject<Record<string, PluginState>>
  resetAutoUpdateSchedule: () => void
  setLoadingForPlugins: (ids: string[]) => void
  setErrorForPlugins: (ids: string[], error: string) => void
  startBatch: StartBatch
}

export function useProbeRefreshActions({
  pluginSettings,
  pluginStatesRef,
  resetAutoUpdateSchedule,
  setLoadingForPlugins,
  setErrorForPlugins,
  startBatch,
}: UseProbeRefreshActionsArgs) {
  const startManualRefresh = useCallback(
    (ids: string[], errorMessage: string) => {
      setLoadingForPlugins(ids)
      startBatch(ids, { manual: true }).catch((error) => {
        console.error(errorMessage, error)
        const failedPluginIds = getProbeBatchStartFailedPluginIds(error, ids)
        if (failedPluginIds.length > 0) {
          setErrorForPlugins(failedPluginIds, "无法开始刷新")
        }
      })
    },
    [setLoadingForPlugins, setErrorForPlugins, startBatch]
  )

  const handleRetryPlugin = useCallback(
    (id: string) => {
      const currentState = pluginStatesRef.current[id]
      if (currentState?.loading) return
      const lastManualRefreshAt = currentState?.lastManualRefreshAt
      if (lastManualRefreshAt && Date.now() - lastManualRefreshAt < REFRESH_COOLDOWN_MS) return

      resetAutoUpdateSchedule()
      startManualRefresh([id], "Failed to retry plugin:")
    },
    [pluginStatesRef, resetAutoUpdateSchedule, startManualRefresh]
  )

  const handleRefreshAll = useCallback(() => {
    if (!pluginSettings) return
    const enabledIds = getEnabledPluginIds(pluginSettings)
    if (enabledIds.length === 0) return

    const now = Date.now()
    const eligibleIds = enabledIds.filter((id) => {
      const currentState = pluginStatesRef.current[id]
      if (currentState?.loading) return false
      const lastManualRefreshAt = currentState?.lastManualRefreshAt
      if (!lastManualRefreshAt) return true
      return now - lastManualRefreshAt >= REFRESH_COOLDOWN_MS
    })
    if (eligibleIds.length === 0) return

    resetAutoUpdateSchedule()
    startManualRefresh(eligibleIds, "Failed to start refresh batch:")
  }, [pluginSettings, pluginStatesRef, resetAutoUpdateSchedule, startManualRefresh])

  return {
    handleRetryPlugin,
    handleRefreshAll,
  }
}
