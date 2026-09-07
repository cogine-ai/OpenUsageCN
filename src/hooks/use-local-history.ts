import { useCallback, useEffect, useRef, useState } from "react"
import { refreshLocalHistory, type LocalHistorySnapshot } from "@/lib/local-history"

type HistoryState = {
  scope: string
  snapshot: LocalHistorySnapshot | null
  loading: boolean
  error: string | null
}

export function useLocalHistory(providerId: string, accountId: string | null, scopeRevision = 0) {
  const scope = JSON.stringify([providerId, accountId, scopeRevision])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const requestRevision = useRef(0)
  const [state, setState] = useState<HistoryState>({ scope, snapshot: null, loading: false, error: null })

  useEffect(() => {
    requestRevision.current += 1
    setState({ scope, snapshot: null, loading: false, error: null })
    return () => { requestRevision.current += 1 }
  }, [scope])

  const load = useCallback(async () => {
    const revision = ++requestRevision.current
    const isCurrent = () => currentScope.current === scope && requestRevision.current === revision
    setState({ scope, snapshot: null, loading: true, error: null })
    try {
      const snapshot = await refreshLocalHistory(providerId, accountId)
      if (!isCurrent()) return
      if (snapshot.providerId !== providerId || snapshot.accountId !== accountId) {
        throw new Error("Local history scope mismatch")
      }
      setState({ scope, snapshot, loading: false, error: null })
    } catch (cause) {
      if (!isCurrent()) return
      console.error("Failed to load local usage history")
      setState({
        scope, snapshot: null, loading: false,
        error: typeof cause === "string" ? cause : "无法读取本地用量，请重试。",
      })
    }
  }, [accountId, providerId, scope])

  return {
    snapshot: state.scope === scope ? state.snapshot : null,
    loading: state.scope === scope && state.loading,
    error: state.scope === scope ? state.error : null,
    load,
  }
}
