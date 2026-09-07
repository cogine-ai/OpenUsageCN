import { useEffect, useState } from "react"
import { listCursorHistorySnapshots, type CompleteHistory } from "@/lib/cursor-history"

export function useCursorHistoryArchive(providerId: string, accountId: string, current: CompleteHistory | null) {
  const [snapshots, setSnapshots] = useState<CompleteHistory[]>([])
  const [error, setError] = useState<string | null>(null)
  const fetchedAtMs = current?.accountId === accountId ? current.coverage.fetchedAtMs : undefined

  useEffect(() => {
    let cancelled = false
    setSnapshots([])
    setError(null)
    if (fetchedAtMs === undefined) return
    async function load() {
      try {
        const recorded = await listCursorHistorySnapshots(providerId, accountId)
        if (cancelled) return
        if (recorded.some((snapshot) => snapshot.accountId !== accountId)) {
          throw new Error("Cursor recorded history account mismatch")
        }
        setSnapshots(recorded)
      } catch {
        if (cancelled) return
        console.error("Failed to load recorded Cursor windows")
        setError("无法读取已记录窗口，已保存的历史不会被清除。")
      }
    }
    void load()
    return () => { cancelled = true }
  }, [providerId, accountId, fetchedAtMs])

  return { snapshots: snapshots.filter((snapshot) => snapshot.accountId === accountId), error }
}
