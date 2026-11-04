import { useCallback, useEffect, useRef } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getOllamaAccounts, OLLAMA_ACCOUNTS_CHANGED, type OllamaAccountsView } from "@/lib/ollama-accounts"
import type { PluginOutput } from "@/lib/plugin-types"

type Projection = { data?: PluginOutput | null; error: string | null; lastUpdatedAt?: number | null }
type Options = {
  enabled: boolean
  isLoading: () => boolean
  apply: (projection: Projection, preserveProbeError?: boolean) => void
}

/** Home shows every connection; the tray continues to read only the explicit primary. */
export function primaryProjection(view: OllamaAccountsView): Projection {
  const connection = view.primary.mode === "legacy"
    ? view.legacy
    : view.primary.mode === "connection"
      ? view.connections.find((item) => item.connectionId === view.primary.connectionId)
      : undefined
  const date = connection?.lastUpdatedAt ? Date.parse(connection.lastUpdatedAt) : NaN
  return {
    data: connection?.snapshot ?? null,
    error: connection?.error?.message ?? (view.primary.mode === "none"
      ? "尚未设置主账号，请在管理账号中选择。"
      : !connection ? "所选主账号不可用，请重新选择。" : null),
    lastUpdatedAt: Number.isFinite(date) ? date : null,
  }
}

/** Mirror persisted account changes to the tray without starting a second all-account refresh. */
export function useOllamaPrimaryProjection({ enabled, isLoading, apply }: Options) {
  const mounted = useRef(false)
  const request = useRef(0)
  const lastProjection = useRef<string | undefined>(undefined)
  const invalidate = useCallback(() => { request.current += 1 }, [])
  const reload = useCallback(async (preserveProbeError = false) => {
    if (!mounted.current) return
    const current = ++request.current
    if (isLoading()) return
    try {
      const view = await getOllamaAccounts()
      if (mounted.current && current === request.current && !isLoading()) {
        const projection = primaryProjection(view)
        const fingerprint = JSON.stringify([view.primary, projection])
        // A sibling rename/refresh must not erase a primary worker failure or invent freshness.
        if (!preserveProbeError && lastProjection.current === fingerprint) return
        lastProjection.current = fingerprint
        apply(projection, preserveProbeError)
      }
    } catch {
      console.error("Failed to synchronize the Ollama primary projection")
      if (mounted.current && current === request.current && !isLoading()) {
        lastProjection.current = undefined
        apply({ data: null, lastUpdatedAt: null, error: "无法读取主账号用量，请重新读取账号状态。" })
      }
    }
  }, [apply, isLoading])

  useEffect(() => {
    if (!enabled) return
    mounted.current = true
    let disposed = false
    let unlisten: UnlistenFn | undefined
    void reload()
    void listen(OLLAMA_ACCOUNTS_CHANGED, () => { void reload() }).then((stop) => {
      if (!disposed) unlisten = stop
      else stop()
    }).catch(() => {
      console.error("Failed to subscribe to Ollama primary projection changes")
      if (!disposed) apply({ error: "主账号实时更新不可用，请重新打开应用。" })
    })
    return () => {
      mounted.current = false
      disposed = true
      request.current += 1
      lastProjection.current = undefined
      unlisten?.()
    }
  }, [enabled, apply, reload])
  return { reload, invalidate }
}
