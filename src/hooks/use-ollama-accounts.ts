import { useCallback, useEffect, useRef, useState } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  getOllamaAccounts,
  performOllamaAccountOperation,
  saveOllamaKey,
  OLLAMA_ACCOUNTS_CHANGED,
  type OllamaAccountOperation,
  type OllamaAccountsView,
} from "@/lib/ollama-accounts"

/** Reads masked connections only; viewing an account never changes the primary projection. */
export function useOllamaAccounts(onPrimaryChange?: () => void, onQuotaRefresh?: () => void) {
  const [view, setView] = useState<OllamaAccountsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const readRevision = useRef(0)
  const operationRevision = useRef(0)
  const viewRef = useRef(view)

  const accept = useCallback((next: OllamaAccountsView) => {
    if (next && (!viewRef.current || next.revision >= viewRef.current.revision)) {
      viewRef.current = next
      setView(next)
    }
  }, [])

  const reload = useCallback(async () => {
    const revision = ++readRevision.current
    try {
      const next = await getOllamaAccounts()
      if (mounted.current && revision === readRevision.current) accept(next)
    } catch {
      console.error("Failed to load Ollama account connections")
      if (mounted.current && revision === readRevision.current)
        setError("无法读取账号连接，请重试。")
    } finally {
      if (mounted.current && revision === readRevision.current) setLoading(false)
    }
  }, [accept])

  useEffect(() => {
    mounted.current = true
    let unlisten: UnlistenFn | undefined
    void reload()
    void listen(OLLAMA_ACCOUNTS_CHANGED, () => {
      void reload()
    })
      .then((stop) => {
        if (mounted.current) unlisten = stop
        else stop()
      })
      .catch(() => {
        console.error("Failed to subscribe to Ollama connection changes")
        if (mounted.current) setError("账号实时更新不可用，请重新打开此页面。")
      })
    return () => {
      mounted.current = false
      readRevision.current += 1
      operationRevision.current += 1
      unlisten?.()
    }
  }, [reload])

  const mutate = useCallback(
    async (work: () => Promise<OllamaAccountsView>, projection?: "primary" | "refresh") => {
      const revision = ++operationRevision.current
      readRevision.current += 1
      setBusy(true)
      setError(null)
      try {
        const next = await work()
        if (!mounted.current || operationRevision.current !== revision) return null
        accept(next)
        if (projection === "primary") onPrimaryChange?.()
        if (projection === "refresh") onQuotaRefresh?.()
        return next
      } catch (reason) {
        console.error("Failed to update Ollama account connection")
        if (mounted.current && operationRevision.current === revision) {
          setError(
            typeof reason === "string" && reason.trim()
              ? reason
              : "账号操作未完成，请重新读取连接状态后重试。"
          )
          await reload()
        }
        return null
      } finally {
        if (mounted.current && operationRevision.current === revision) setBusy(false)
      }
    },
    [accept, onPrimaryChange, onQuotaRefresh, reload]
  )

  const operate = useCallback(
    (operation: OllamaAccountOperation) => {
      const primaryChanged =
        operation.kind === "selectPrimary" ||
        operation.kind === "useLegacy" ||
        (operation.kind === "remove" &&
          viewRef.current?.primary.connectionId === operation.connectionId)
      const quotaRefreshed =
        operation.kind === "refresh" &&
        (!operation.connectionId ||
          viewRef.current?.primary.connectionId === operation.connectionId)
      return mutate(
        () => performOllamaAccountOperation(operation),
        primaryChanged ? "primary" : quotaRefreshed ? "refresh" : undefined
      )
    },
    [mutate]
  )

  const save = useCallback(
    (verificationId: string, label: string, asNew: boolean, editingId?: string) =>
      mutate(
        () => saveOllamaKey(verificationId, label, asNew),
        editingId && !asNew && viewRef.current?.primary.connectionId === editingId
          ? "primary"
          : undefined
      ),
    [mutate]
  )

  return { view, loading, busy, error, reload, operate, save }
}
