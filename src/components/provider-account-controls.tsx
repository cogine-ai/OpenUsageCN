import { useState } from "react"
import { AlertTriangle, Globe2, Pencil, RefreshCw, Unlink } from "lucide-react"

import { BrowserAccountManager } from "@/components/browser-account-manager"
import { CursorModelUsage } from "@/components/cursor-model-usage"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState("")
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
  } = useProviderAccounts(providerId)
  const unavailableSources =
    receipt?.sourceOutcomes
      .filter((outcome) => outcome.status === "unavailable")
      .map((outcome) => outcome.sourceKey) ?? []

  return (
    <>
      <section className="mt-4 space-y-3 rounded-lg border border-border bg-background p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Provider Accounts</h3>
            <p className="text-xs text-muted-foreground">选择此服务商当前使用的本机账号</p>
          </div>
          <Button
            type="button"
            size="sm"
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
            刷新账号
          </Button>
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
              return (
                <div
                  key={account.accountId}
                  className="space-y-2 rounded-md border border-border p-2 text-sm"
                >
                  <div className="flex items-center gap-2">
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
                      <span className="block text-xs text-muted-foreground">
                        {account.connectionKinds
                          .map((kind) => CONNECTION_LABELS[kind])
                          .join(" · ")}
                      </span>
                    </label>
                    {account.stale ? (
                      <span className="text-xs text-muted-foreground">数据可能已过期</span>
                    ) : null}
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`重命名 ${account.label}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingAccountId(account.accountId)
                        setDraftLabel(account.label)
                      }}
                    >
                      <Pencil className="size-3" />
                    </Button>
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
                        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
                    <div className="space-y-1 border-t border-border pt-2 pl-5">
                      <p className="text-xs font-medium">Browser Connections</p>
                      {browserConnections.map((connection) => {
                        const browserLabel = CONNECTION_LABELS[connection.kind]
                        const profileLabel = connection.profileKey ?? "Unknown Profile"
                        return (
                          <div
                            key={connection.connectionId}
                            className="flex items-center gap-2 text-xs"
                          >
                            <Globe2 className="size-3 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                              {browserLabel} · {profileLabel}
                            </span>
                            <Badge variant="outline">
                              {connection.available ? "Available" : "Unavailable"}
                            </Badge>
                            <Button
                              type="button"
                              size="icon-xs"
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
                              <Unlink className="size-3" />
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
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
    </>
  )
}
