import { useCallback, useEffect, useRef, useState } from "react"
import { cancelProviderReports, refreshProviderReports, type ProviderReportsSnapshot } from "@/lib/provider-reports"
import { PROVIDER_CONFIG_CHANGED } from "@/lib/provider-config"

export function useProviderReports(providerId: string, connectionId?: string, useLegacy = false) {
  const active = useRef<{ id: string; providerId: string } | null>(null)
  const revision = useRef(0)
  const [snapshot, setSnapshot] = useState<ProviderReportsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invalidate = useCallback(() => {
    revision.current += 1
    const pending = active.current
    active.current = null
    if (pending) {
      void cancelProviderReports(pending.providerId, pending.id).catch(() => {
        console.error("Failed to cancel server reports")
      })
    }
  }, [])

  useEffect(() => {
    setSnapshot(null); setLoading(false); setError(null)
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== providerId) return
      // Named Ollama keys have their own credentials; legacy settings cannot change their scope.
      if (providerId === "ollama" && connectionId && !useLegacy) return
      invalidate()
      setSnapshot(null); setLoading(false); setError(null)
    }
    window.addEventListener(PROVIDER_CONFIG_CHANGED, changed)
    return () => {
      window.removeEventListener(PROVIDER_CONFIG_CHANGED, changed)
      invalidate()
    }
  }, [providerId, connectionId, useLegacy, invalidate])

  const load = useCallback(async () => {
    invalidate()
    const current = revision.current
    const requestId = crypto.randomUUID()
    active.current = { id: requestId, providerId }
    // Do not display a previous scope while another identity may be loading.
    setSnapshot(null); setLoading(true); setError(null)
    try {
      const next = await refreshProviderReports(providerId, requestId, connectionId, useLegacy)
      if (revision.current !== current) return
      if (next.providerId !== providerId || next.requestId !== requestId || !/^[a-f0-9]{64}$/.test(next.scopeKey)) {
        throw new Error("Server report scope mismatch")
      }
      setSnapshot(next)
    } catch {
      if (revision.current !== current) return
      console.error("Failed to load server reports")
      setError("无法读取服务端报告，请检查当前连接后重试。")
    } finally {
      if (revision.current === current) {
        active.current = null
        setLoading(false)
      }
    }
  }, [providerId, connectionId, useLegacy, invalidate])

  return { snapshot, loading, error, load }
}
