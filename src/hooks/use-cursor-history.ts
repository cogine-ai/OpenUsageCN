import { useEffect, useRef, useState } from "react"

import {
  getCursorHistorySnapshot,
  refreshCursorHistory,
  type CompleteHistory,
  type CursorHistoryRefreshError,
} from "@/lib/cursor-history"

const SYSTEM_ERROR: CursorHistoryRefreshError = {
  code: "historyUnavailable",
  message: "Unable to load Model Usage. Try again.",
}

function localTimeZone() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!timeZone) throw new Error("Local time zone is unavailable")
  return timeZone
}

export function useCursorHistory(
  providerId: string,
  accountId: string,
  demandRevision = 0
) {
  const requestRevision = useRef(0)
  const [snapshot, setSnapshot] = useState<CompleteHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<CursorHistoryRefreshError | null>(null)

  useEffect(() => {
    const revision = ++requestRevision.current
    let cancelled = false
    let cachedSnapshot: CompleteHistory | null = null

    setSnapshot(null)
    setLoading(true)
    setRefreshing(false)
    setStale(false)
    setError(null)

    const isCurrent = () => !cancelled && requestRevision.current === revision

    async function load() {
      try {
        const loadedSnapshot = await getCursorHistorySnapshot(providerId, accountId)
        if (!isCurrent()) return
        if (loadedSnapshot && loadedSnapshot.accountId !== accountId) {
          throw new Error("Cursor history account mismatch")
        }
        cachedSnapshot = loadedSnapshot
        setSnapshot(cachedSnapshot)
        setLoading(false)
        setRefreshing(true)

        const result = await refreshCursorHistory({
          providerId,
          accountId,
          timeZone: localTimeZone(),
        })
        if (!isCurrent()) return
        if (result.snapshot && result.snapshot.accountId !== accountId) {
          throw new Error("Cursor history refresh account mismatch")
        }
        setSnapshot(result.snapshot)
        setStale(result.stale)
        setError(result.error ?? null)
      } catch {
        if (!isCurrent()) return
        console.error("Failed to load Cursor model usage")
        setSnapshot(cachedSnapshot)
        setStale(cachedSnapshot !== null)
        setError(SYSTEM_ERROR)
      } finally {
        if (isCurrent()) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [accountId, demandRevision, providerId])

  return {
    snapshot,
    loading,
    refreshing,
    stale,
    error,
    unavailable: !loading && !refreshing && snapshot === null && error === null,
  }
}
