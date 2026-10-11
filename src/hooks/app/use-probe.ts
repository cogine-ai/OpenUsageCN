import { useCallback } from "react"
import { useProbeEvents } from "@/hooks/use-probe-events"
import {
  type AutoUpdateIntervalMinutes,
  type PluginSettings,
} from "@/lib/settings"
import { useProbeAutoUpdate } from "@/hooks/app/use-probe-auto-update"
import { useProbeRefreshActions } from "@/hooks/app/use-probe-refresh-actions"
import { useProbeState } from "@/hooks/app/use-probe-state"

type UseProbeArgs = {
  pluginSettings: PluginSettings | null
  autoUpdateInterval: AutoUpdateIntervalMinutes
  onProbeResult?: () => void
}

/** Combine scheduled refreshes, account transitions, and explicit connection verification. */
export function useProbe({
  pluginSettings,
  autoUpdateInterval,
  onProbeResult,
}: UseProbeArgs) {
  const {
    pluginStates,
    pluginStatesRef,
    setLoadingForPlugins,
    setAccountTransitionForPlugins,
    setErrorForPlugins,
    handleProbeResult,
  } = useProbeState({ onProbeResult })

  /** Keep completion registration stable; individual results own provider state updates. */
  const handleBatchComplete = useCallback(() => {}, [])

  const { startBatch, verifyPlugin } = useProbeEvents({
    onResult: handleProbeResult,
    onBatchComplete: handleBatchComplete,
  })

  /** Read the latest pending state so scheduled checks do not duplicate an in-flight refresh. */
  const isPluginLoading = useCallback(
    (id: string) => Boolean(pluginStatesRef.current[id]?.loading),
    [pluginStatesRef]
  )

  const {
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    resetAutoUpdateSchedule,
  } = useProbeAutoUpdate({
    pluginSettings,
    autoUpdateInterval,
    pluginStates,
    pluginStatesRef,
    setLoadingForPlugins,
    setErrorForPlugins,
    isPluginLoading,
    startBatch,
  })

  const {
    handleRetryPlugin,
    handleAccountChangeRefresh,
    handleRefreshAll,
  } = useProbeRefreshActions({
    pluginSettings,
    pluginStatesRef,
    resetAutoUpdateSchedule,
    setLoadingForPlugins,
    setAccountTransitionForPlugins,
    setErrorForPlugins,
    startBatch,
  })

  return {
    verifyPlugin,
    pluginStates,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    handleRetryPlugin,
    handleAccountChangeRefresh,
    handleRefreshAll,
  }
}
