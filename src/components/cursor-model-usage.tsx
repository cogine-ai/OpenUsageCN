import { useState } from "react"
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react"
import { CursorHistoryControls } from "@/components/cursor-history-controls"
import { snapshotTotals, historyDateTime, HISTORY_USD_FORMAT as USD_FORMAT } from "@/lib/cursor-history-summary"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { useCursorHistory } from "@/hooks/use-cursor-history"
import type { CompleteHistory, CursorHistoryListCostCoverage } from "@/lib/cursor-history"
import { formatCountNumber } from "@/lib/utils"

type CursorModelUsageProps = {
  providerId: string
  accountId: string
  demandRevision?: number
}

type ModelTotal = {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requestCount: number
  knownListCostUsd: number | null
  listCostCoverage: CursorHistoryListCostCoverage
}

function combinedCoverage(
  current: CursorHistoryListCostCoverage,
  next: CursorHistoryListCostCoverage
): CursorHistoryListCostCoverage {
  if (current === "invalid" || next === "invalid") return "invalid"
  if (current === "partial" || next === "partial") return "partial"
  return "complete"
}

function modelTotals(snapshot: CompleteHistory): ModelTotal[] {
  const models = new Map<string, ModelTotal>()
  for (const bucket of snapshot.buckets) {
    const current = models.get(bucket.modelName)
    if (!current) {
      models.set(bucket.modelName, {
        modelName: bucket.modelName,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        requestCount: bucket.requestCount,
        knownListCostUsd: bucket.knownListCostUsd,
        listCostCoverage: bucket.listCostCoverage,
      })
      continue
    }
    current.inputTokens += bucket.inputTokens
    current.outputTokens += bucket.outputTokens
    current.cacheWriteTokens += bucket.cacheWriteTokens
    current.cacheReadTokens += bucket.cacheReadTokens
    current.requestCount += bucket.requestCount
    if (bucket.knownListCostUsd !== null) {
      current.knownListCostUsd =
        (current.knownListCostUsd ?? 0) + bucket.knownListCostUsd
    }
    current.listCostCoverage = combinedCoverage(
      current.listCostCoverage,
      bucket.listCostCoverage
    )
  }
  return [...models.values()]
}

export function CursorModelUsage(props: CursorModelUsageProps) {
  return <CursorModelUsageAccount key={`${props.providerId}:${props.accountId}`} {...props} />
}

function CursorModelUsageAccount({
  providerId,
  accountId,
  demandRevision = 0,
}: CursorModelUsageProps) {
  const { snapshot, loading, refreshing, stale, error, unavailable } = useCursorHistory(
    providerId,
    accountId,
    demandRevision
  )
  const [expandedModels, setExpandedModels] = useState<Set<string>>(() => new Set())
  const totals = snapshot ? snapshotTotals(snapshot) : null
  const models = snapshot ? modelTotals(snapshot) : []
  const terminalError = snapshot === null ? error : null
  const status = terminalError
    ? "Error"
    : unavailable
      ? "Unavailable"
      : stale
        ? "Stale"
        : totals?.partialListPrice
          ? "Partial Cost"
          : null

  return (
    <section className="mt-4 space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 items-center gap-2">
          <h3 className="whitespace-nowrap text-sm font-semibold">Model Usage</h3>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
          {refreshing ? (
            <Badge variant="outline" className="gap-1">
              <RefreshCw className="size-3 animate-spin" />
              Refreshing
            </Badge>
          ) : null}
          {status ? <Badge variant="outline">{status}</Badge> : null}
        </div>
      </div>

      {!snapshot && (loading || refreshing) ? (
        <p className="text-sm text-muted-foreground">Loading Model Usage…</p>
      ) : null}

      {unavailable ? (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>Model Usage Unavailable</AlertTitle>
          <AlertDescription>
            No Session-Visible Usage is available for this account.
          </AlertDescription>
        </Alert>
      ) : null}

      {terminalError ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Model Usage Error</AlertTitle>
          <AlertDescription>{terminalError.message}</AlertDescription>
        </Alert>
      ) : null}

      {snapshot && totals ? (
        <>
          <CursorHistoryControls providerId={providerId} accountId={accountId} snapshot={snapshot} refreshing={refreshing} />
          <dl className="space-y-2 text-sm tabular-nums">
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Session-Visible Usage</dt>
              <dd>{formatCountNumber(totals.requests)} Requests · {formatCountNumber(totals.tokens)} Tokens</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-muted-foreground">List-Price Equivalent</dt>
              <dd>{totals.knownListPriceBuckets > 0 ? USD_FORMAT.format(totals.listPrice) : "Unavailable"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-muted-foreground">Metered Usage</dt>
              <dd>{snapshot.totals.meteredChargedUsd === null ? "Unavailable" : USD_FORMAT.format(snapshot.totals.meteredChargedUsd)}{snapshot.totals.meteredCoverage === "incomplete" ? " · Incomplete" : ""}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">金额来自会话可见记录，不是账单。</p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-ring">数据说明</summary>
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Coverage {historyDateTime(snapshot.coverage.fromMs, snapshot.coverage.timeZone, true)} –{" "}
                  {historyDateTime(snapshot.coverage.toMs, snapshot.coverage.timeZone, true)}
                </span>
                <span>
                  Updated {historyDateTime(snapshot.coverage.fetchedAtMs, snapshot.coverage.timeZone, true)} ·{" "}
                  {snapshot.coverage.timeZone}
                </span>
              </div>

              <p className="text-xs text-muted-foreground">分页完整仅表示已取回所示窗口的数据，不代表完整账期；金额来自 Cursor 会话可见记录，不是账单。</p>
              <p className="text-xs text-muted-foreground">仅缓存最近一次成功结果；刷新替换缓存，不累计历史用量。</p>
            </div>
          </details>

          {stale ? (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>Model Usage Stale</AlertTitle>
              <AlertDescription>
                {error?.message ?? "Showing the last complete Model Usage snapshot."}
              </AlertDescription>
            </Alert>
          ) : null}

          {totals.partialListPrice ? (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>Partial List-Price Coverage</AlertTitle>
              <AlertDescription>
                List-Price Equivalent includes only usage with a known model price.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="divide-y divide-border">
            {models.map((model) => {
              const totalTokens =
                model.inputTokens +
                model.outputTokens +
                model.cacheWriteTokens +
                model.cacheReadTokens
              return (
                <details
                  key={model.modelName}
                  open={expandedModels.has(model.modelName)}
                  onToggle={(event) => {
                    const open = event.currentTarget.open
                    setExpandedModels((previous) => {
                      if (previous.has(model.modelName) === open) return previous
                      const next = new Set(previous)
                      if (open) next.add(model.modelName)
                      else next.delete(model.modelName)
                      return next
                    })
                  }}
                  className="group py-3 first:pt-0 last:pb-0"
                >
                  <summary className="cursor-pointer list-none rounded-sm focus-visible:outline focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <div className="flex items-start gap-2">
                      <h4 className="min-w-0 flex-1 break-words text-sm font-medium">
                        {model.modelName.trim().length === 0 ? "Unknown" : model.modelName}
                      </h4>
                      <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground tabular-nums">Total Tokens {formatCountNumber(totalTokens)} · {formatCountNumber(model.requestCount)} Requests</div>
                    <div className="text-xs text-muted-foreground tabular-nums">List Price {model.knownListCostUsd === null ? "Unavailable" : USD_FORMAT.format(model.knownListCostUsd)}</div>
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>Input {formatCountNumber(model.inputTokens)}</span>
                    <span>Output {formatCountNumber(model.outputTokens)}</span>
                    <span>Cache Write {formatCountNumber(model.cacheWriteTokens)}</span>
                    <span>Cache Read {formatCountNumber(model.cacheReadTokens)}</span>
                  </div>
                </details>
              )
            })}
          </div>
        </>
      ) : null}
    </section>
  )
}
