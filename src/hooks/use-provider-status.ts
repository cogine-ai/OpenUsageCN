import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { PluginStatusPage, ProviderStatus } from "@/lib/plugin-types"

const POLL_INTERVAL_MS = 5 * 60 * 1000
const successfulStatus = new Map<string, ProviderStatus>()
const pendingStatus = new Map<string, Promise<ProviderStatus>>()

function checkProviderStatus(pluginId: string): Promise<ProviderStatus> {
  const pending = pendingStatus.get(pluginId)
  if (pending) return pending

  const request = invoke<ProviderStatus>("get_provider_status", { pluginId })
    .then((status) => {
      successfulStatus.set(pluginId, status)
      return status
    })
    .finally(() => {
      pendingStatus.delete(pluginId)
    })
  pendingStatus.set(pluginId, request)
  return request
}

export function useProviderStatus(
  pluginId: string,
  statusPage?: PluginStatusPage
): ProviderStatus | null {
  const [statusState, setStatusState] = useState<{
    pluginId: string
    status: ProviderStatus | null
  }>(() => ({
    pluginId,
    status: statusPage ? successfulStatus.get(pluginId) ?? null : null,
  }))

  useEffect(() => {
    if (!statusPage) {
      setStatusState({ pluginId, status: null })
      return
    }

    setStatusState({
      pluginId,
      status: successfulStatus.get(pluginId) ?? null,
    })
    let active = true
    const refresh = () => {
      void checkProviderStatus(pluginId)
        .then((nextStatus) => {
          if (active) setStatusState({ pluginId, status: nextStatus })
        })
        .catch((error) => {
          console.error(`[provider-status] ${pluginId} check failed`, error)
        })
    }

    refresh()
    const intervalId = window.setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [pluginId, statusPage])

  if (!statusPage) return null
  return statusState.pluginId === pluginId
    ? statusState.status
    : successfulStatus.get(pluginId) ?? null
}
