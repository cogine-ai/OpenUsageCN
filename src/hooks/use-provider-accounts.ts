import { useCallback, useEffect, useRef, useState } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import {
  getProviderAccountView,
  performProviderAccountOperation,
} from "@/lib/provider-accounts"
import type {
  ProviderAccountOperation,
  ProviderAccountOperationReceipt,
  ProviderAccountView,
} from "@/lib/plugin-types"

type ProviderAccountViewChanged = {
  providerId: string
  revision: number
}

const VIEW_CHANGE_SETTLE_MS = 50

export function useProviderAccounts(providerId: string) {
  const currentProviderId = useRef(providerId)
  const operationRevision = useRef(0)
  const viewReadRevision = useRef(0)
  currentProviderId.current = providerId
  const [view, setView] = useState<ProviderAccountView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ProviderAccountOperationReceipt | null>(null)
  const [accountRevision, setAccountRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null
    let eventReadTimer: ReturnType<typeof setTimeout> | null = null
    let latestEventRevision = 0
    operationRevision.current += 1
    setLoading(true)
    setView(null)
    setBusy(false)
    setError(null)
    setReceipt(null)
    setAccountRevision(0)

    const readView = (initial: boolean, eventRevision?: number) => {
      const revision = ++viewReadRevision.current
      getProviderAccountView(providerId)
        .then((nextView) => {
          if (
            cancelled ||
            currentProviderId.current !== providerId ||
            viewReadRevision.current !== revision
          ) {
            return
          }
          setView(nextView)
          setError(null)
          if (eventRevision !== undefined) setAccountRevision(eventRevision)
        })
        .catch((cause) => {
          if (
            cancelled ||
            currentProviderId.current !== providerId ||
            viewReadRevision.current !== revision
          ) {
            return
          }
          console.error("Failed to load provider accounts:", cause)
          setError(initial ? "无法加载账号" : "无法刷新账号数据，请重试")
        })
        .finally(() => {
          if (
            !cancelled &&
            currentProviderId.current === providerId &&
            viewReadRevision.current === revision
          ) {
            setLoading(false)
          }
        })
    }

    readView(true)
    void listen<ProviderAccountViewChanged>("provider-account-view-changed", (event) => {
      if (
        cancelled ||
        event.payload.providerId !== providerId ||
        event.payload.revision <= latestEventRevision
      ) {
        return
      }
      latestEventRevision = event.payload.revision
      viewReadRevision.current += 1
      if (eventReadTimer) clearTimeout(eventReadTimer)
      eventReadTimer = setTimeout(() => {
        eventReadTimer = null
        readView(false, latestEventRevision)
      }, VIEW_CHANGE_SETTLE_MS)
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten()
        } else {
          unlisten = nextUnlisten
        }
      })
      .catch((cause) => {
        if (!cancelled) console.error("Failed to listen for provider account changes:", cause)
      })

    return () => {
      cancelled = true
      if (eventReadTimer) clearTimeout(eventReadTimer)
      viewReadRevision.current += 1
      unlisten?.()
    }
  }, [providerId])

  const runOperation = useCallback(
    async (operation: ProviderAccountOperation) => {
      const targetProviderId = providerId
      const revision = ++operationRevision.current
      setBusy(true)
      setError(null)
      try {
        const nextReceipt = await performProviderAccountOperation(targetProviderId, operation)
        if (
          currentProviderId.current !== targetProviderId ||
          operationRevision.current !== revision
        ) {
          return null
        }
        viewReadRevision.current += 1
        setView(nextReceipt.view)
        setReceipt(nextReceipt)
        return nextReceipt
      } catch {
        console.error("Failed to perform provider account operation")
        if (
          currentProviderId.current === targetProviderId &&
          operationRevision.current === revision
        ) {
          setError("账号操作失败，请重试")
        }
        return null
      } finally {
        if (
          currentProviderId.current === targetProviderId &&
          operationRevision.current === revision
        ) {
          setBusy(false)
        }
      }
    },
    [providerId]
  )

  const selectAccount = useCallback(
    (accountId: string) => runOperation({ kind: "selectActive", accountId }),
    [runOperation]
  )

  const followDefault = useCallback(
    () => runOperation({ kind: "followDefaultConnection" }),
    [runOperation]
  )

  const refreshActive = useCallback(
    () => runOperation({ kind: "refreshActive" }),
    [runOperation]
  )

  const renameAccount = useCallback(
    (accountId: string, label: string) =>
      runOperation({ kind: "renameAccount", accountId, label }),
    [runOperation]
  )

  const attachBrowserCandidate = useCallback(
    (candidateId: string) => runOperation({ kind: "attachBrowserCandidate", candidateId }),
    [runOperation]
  )

  const detachConnection = useCallback(
    (accountId: string, connectionId: string) =>
      runOperation({ kind: "detachConnection", accountId, connectionId }),
    [runOperation]
  )

  return {
    view,
    loading,
    busy,
    error,
    receipt,
    accountRevision,
    selectAccount,
    followDefault,
    refreshActive,
    renameAccount,
    attachBrowserCandidate,
    detachConnection,
  }
}
