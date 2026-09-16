import { useId, useState } from "react"
import { AlertTriangle, ChevronDown, Pencil, RefreshCw, Unlink } from "lucide-react"

import { RemoveAccountButton } from "@/components/remove-account-button"
import { BrowserAccountManager } from "@/components/browser-account-manager"
import { CursorModelUsage } from "@/components/cursor-model-usage"
import { LocalUsageHistory } from "@/components/local-usage-history"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { compactFieldClassName } from "@/components/ui/field"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useProviderAccounts } from "@/hooks/use-provider-accounts"
import type {
  ProviderAccountConnectionKind,
  ProviderAccountOperationReceipt,
} from "@/lib/plugin-types"

const CONNECTION_LABELS: Record<ProviderAccountConnectionKind, string> = {
  desktop: "Desktop",
  cli: "CLI",
  chrome: "Chrome",
  arc: "Arc",
}

type ProviderAccountControlsProps = {
  providerId: string
  browserBinding?: boolean
  modelHistory?: boolean
  onAccountChangeRefresh?: () => void
}

function activeAccountChanged(
  previousAccountId: string | null,
  receipt: ProviderAccountOperationReceipt | null
) {
  return (
    receipt !== null &&
    receipt.status !== "failed" &&
    receipt.view.activeAccountId !== previousAccountId
  )
}

export function ProviderAccountControls({
  providerId,
  browserBinding = false,
  modelHistory = false,
  onAccountChangeRefresh,
}: ProviderAccountControlsProps) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState("")
  const [cleanupRetry, setCleanupRetry] = useState<{ accountId: string; label: string } | null>(null)
  const {
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
    removeAccount,
    reconnectLocal,
  } = useProviderAccounts(providerId)
  const activeAccount = view?.accounts.find((account) => account.accountId === view.activeAccountId)
  const activeSources = activeAccount?.connections.length
    ? activeAccount.connections.map((connection) =>
        [CONNECTION_LABELS[connection.kind], connection.profileKey].filter(Boolean).join(" · ")
      ).join(" / ")
    : activeAccount?.connectionKinds.map((kind) => CONNECTION_LABELS[kind]).join(" · ")
  const summary = activeAccount
    ? [view?.selection.mode === "auto" ? "自动" : null, activeAccount.label, activeSources || "未连接"]
        .filter(Boolean).join(" · ")
    : "未连接账号"
  const activeUnavailable = activeAccount && activeAccount.connections.length > 0 &&
    !activeAccount.connections.some((connection) => connection.available)
  const removeAndRefresh = async (account: { accountId: string; label: string }) => {
    const previousAccountId = view?.activeAccountId ?? null
    const nextReceipt = await removeAccount(account.accountId)
    if (nextReceipt && nextReceipt.view.activeAccountId !== previousAccountId) {
      onAccountChangeRefresh?.()
    }
    const succeeded = nextReceipt !== null && nextReceipt.status !== "failed"
    if (succeeded) setCleanupRetry(null)
    else if (nextReceipt && !nextReceipt.view.accounts.some((item) => item.accountId === account.accountId)) {
      setCleanupRetry(account)
    }
    return succeeded
  }
  const unavailableSources =
    receipt?.sourceOutcomes
      .filter((outcome) => outcome.status === "unavailable")
      .map((outcome) => outcome.sourceKey) ?? []
  const localHistoryAccount = providerId === "claude" && view?.providerId === providerId
    ? view.accounts.find((account) => account.accountId === view.activeAccountId)
    : undefined
  const localHistoryConnection = localHistoryAccount?.connections.find(
    (connection) => connection.kind === "cli" && connection.available
  )

  return (
    <>
      <section className="mt-4 space-y-3 rounded-lg border border-border bg-background p-3">
        <h3 aria-label="账号">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-describedby={`${panelId}-summary`}
            aria-label="账号"
            className="flex w-full items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="shrink-0 text-sm font-semibold">账号</span>
            <span id={`${panelId}-summary`} className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={summary}>
              {summary}
            </span>
            <ChevronDown className={`size-4 shrink-0 ${expanded ? "rotate-180" : ""}`} />
          </button>
        </h3>
        {!expanded && activeAccount?.stale ? <p className="text-xs text-muted-foreground">数据可能已过期</p> : null}
        {!expanded && activeUnavailable ? <p className="text-xs text-destructive">连接不可用</p> : null}
        <div id={panelId} hidden={!expanded} className="space-y-3">
          <div className="flex justify-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    aria-label="刷新账号"
                    size="icon-sm"
                    variant="outline"
                    disabled={loading || busy}
                    onClick={() => {
                      const previousAccountId = view?.activeAccountId ?? null
                      void refreshActive().then((nextReceipt) => {
                        if (activeAccountChanged(previousAccountId, nextReceipt)) {
                          onAccountChangeRefresh?.()
                        }
                      })
                    }}
                  >
                    <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
                  </Button>
                }
              />
              <TooltipContent>刷新账号</TooltipContent>
            </Tooltip>
          </div>

          {loading ? <p className="text-sm text-muted-foreground">正在读取账号…</p> : null}
          {!loading && error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!loading && view ? (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm">
                <input
                  type="radio"
                  name={`${providerId}-account-selection`}
                  checked={view.selection.mode === "auto"}
                  disabled={busy}
                  onChange={() => {
                    const previousAccountId = view.activeAccountId
                    void followDefault().then((nextReceipt) => {
                      if (activeAccountChanged(previousAccountId, nextReceipt)) {
                        onAccountChangeRefresh?.()
                      }
                    })
                  }}
                />
                <span>
                  <span className="block font-medium">自动跟随</span>
                  <span className="block text-xs text-muted-foreground">跟随本机默认连接</span>
                </span>
              </label>

              {view.accounts.map((account) => {
                const inputId = `${providerId}-account-${account.accountId}`
                const editing = editingAccountId === account.accountId
                const browserConnections = account.connections.filter(
                  (connection) => connection.kind === "chrome" || connection.kind === "arc"
                )
                const localConnectionLabels = account.connectionKinds
                  .filter((kind) => kind === "desktop" || kind === "cli")
                  .map((kind) => CONNECTION_LABELS[kind])
                return (
                  <div
                    key={account.accountId}
                    className="space-y-2 rounded-md border border-border p-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        id={inputId}
                        type="radio"
                        name={`${providerId}-account-selection`}
                        checked={
                          view.selection.mode === "pinned" &&
                          view.selection.accountId === account.accountId
                        }
                        disabled={busy}
                        onChange={() => {
                          const previousAccountId = view.activeAccountId
                          void selectAccount(account.accountId).then((nextReceipt) => {
                            if (activeAccountChanged(previousAccountId, nextReceipt)) {
                              onAccountChangeRefresh?.()
                            }
                          })
                        }}
                      />
                      <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                        <span className="block truncate font-medium">{account.label}</span>
                        {localConnectionLabels.length > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {localConnectionLabels.join(" · ")}
                          </span>
                        ) : null}
                      </label>
                      {account.stale ? (
                        <span className="text-xs text-muted-foreground">数据可能已过期</span>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`重命名 ${account.label}`}
                              disabled={busy}
                              onClick={() => {
                                setEditingAccountId(account.accountId)
                                setDraftLabel(account.label)
                              }}
                            >
                              <Pencil className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>重命名 {account.label}</TooltipContent>
                      </Tooltip>
                      <RemoveAccountButton
                        account={account}
                        active={account.accountId === view.activeAccountId}
                        busy={busy || cleanupRetry !== null}
                        onRemove={() => removeAndRefresh(account)}
                      />
                    </div>
                    {editing ? (
                      <form
                        className="flex gap-2 pl-5"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void renameAccount(account.accountId, draftLabel.trim()).then((nextReceipt) => {
                            if (nextReceipt && nextReceipt.status !== "failed") {
                              setEditingAccountId(null)
                            }
                          })
                        }}
                      >
                        <input
                          aria-label="账号名称"
                          value={draftLabel}
                          maxLength={64}
                          disabled={busy}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          className={`${compactFieldClassName} min-w-0 flex-1`}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          disabled={busy || draftLabel.trim().length === 0}
                        >
                          保存名称
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditingAccountId(null)}
                        >
                          取消
                        </Button>
                      </form>
                    ) : null}
                    {browserConnections.length > 0 ? (
                      <div className="space-y-1 pl-5">
                        {browserConnections.map((connection) => {
                          const browserLabel = CONNECTION_LABELS[connection.kind]
                          const profileLabel = connection.profileKey ?? "Unknown Profile"
                          return (
                            <div
                              key={connection.connectionId}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {browserLabel} · {profileLabel}
                              </span>
                              {!connection.available ? (
                                <Badge variant="outline">Unavailable</Badge>
                              ) : null}
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      type="button"
                                      size="icon-sm"
                                      variant="ghost"
                                      aria-label={`Detach ${browserLabel} ${profileLabel}`}
                                      disabled={busy}
                                      onClick={() => {
                                        const previousAccountId = view.activeAccountId
                                        void detachConnection(
                                          account.accountId,
                                          connection.connectionId
                                        ).then((nextReceipt) => {
                                          if (
                                            nextReceipt &&
                                            nextReceipt.status !== "failed" &&
                                            (account.accountId === previousAccountId ||
                                              nextReceipt.view.activeAccountId !== previousAccountId)
                                          ) {
                                            onAccountChangeRefresh?.()
                                          }
                                        })
                                      }}
                                    >
                                      <Unlink className="size-4" />
                                    </Button>
                                  }
                                />
                                <TooltipContent>解绑 {browserLabel} · {profileLabel}</TooltipContent>
                              </Tooltip>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
                const previousAccountId = view.activeAccountId
                void reconnectLocal().then((nextReceipt) => {
                  if (activeAccountChanged(previousAccountId, nextReceipt)) onAccountChangeRefresh?.()
                })
              }}>重新添加本机账号</Button>
              {(providerId === "cursor" || providerId === "claude") && browserBinding ? (
                <BrowserAccountManager
                  busy={busy}
                  providerId={providerId}
                  onAttach={async (candidateId) => {
                    const previousAccountId = view.activeAccountId
                    const nextReceipt = await attachBrowserCandidate(candidateId)
                    if (
                      activeAccountChanged(previousAccountId, nextReceipt) ||
                      (providerId === "claude" &&
                        nextReceipt !== null &&
                        nextReceipt.status !== "failed")
                    ) {
                      onAccountChangeRefresh?.()
                    }
                    return nextReceipt
                  }}
                />
              ) : null}
            </div>
          ) : null}

        </div>
        {!expanded && loading ? <p className="text-sm text-muted-foreground">正在读取账号…</p> : null}
        {!expanded && error ? <p className="text-sm text-destructive">{error}</p> : null}

        {cleanupRetry ? (
          <div className="space-y-2">
            <p className="text-xs text-destructive">{cleanupRetry.label} 已移除，本地缓存清理尚未完成。</p>
            <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => { void removeAndRefresh(cleanupRetry) }}>
              重试清理缓存
            </Button>
          </div>
        ) : null}

        {view?.persistenceWarning ? (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Account Storage Warning</AlertTitle>
            <AlertDescription className="space-y-1">
              <p>{view.persistenceWarning.message}</p>
              <p className="text-xs text-muted-foreground">
                Reference: {view.persistenceWarning.correlationId}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {view?.enrichmentWarning ? (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Claude Team Verification</AlertTitle>
            <AlertDescription className="space-y-1">
              <p>{view.enrichmentWarning.message}</p>
              <p className="text-xs text-muted-foreground">
                Reference: {view.enrichmentWarning.correlationId}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {receipt?.status === "partial" ? (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Account Refresh Partial</AlertTitle>
            <AlertDescription>
              {unavailableSources.length > 0
                ? `${unavailableSources.join("、")} 暂时不可用，已保留其他来源的数据。`
                : "部分账号来源暂时不可用，已保留可用数据。"}
            </AlertDescription>
          </Alert>
        ) : null}
        {receipt?.status === "failed" ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>Account Operation Failed</AlertTitle>
            <AlertDescription>
              {receipt.error?.message ?? "账号操作失败，请重试。"}
            </AlertDescription>
          </Alert>
        ) : null}
      </section>
      {providerId === "cursor" && modelHistory && view?.activeAccountId ? (
        <CursorModelUsage
          key={`${providerId}:${view.activeAccountId}`}
          providerId={providerId}
          accountId={view.activeAccountId}
          demandRevision={accountRevision}
        />
      ) : null}
      {!loading && localHistoryAccount && localHistoryConnection ? (
        <LocalUsageHistory
          key={`${providerId}:${localHistoryAccount.accountId}:${localHistoryConnection.connectionId}`}
          providerId={providerId}
          accountId={localHistoryAccount.accountId}
          disabled={busy}
        />
      ) : null}
    </>
  )
}
