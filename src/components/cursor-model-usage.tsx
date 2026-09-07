import { useState } from "react"
import { Activity, AlertTriangle, RefreshCw } from "lucide-react"
import { CursorHistoryControls, CursorHistoryComparison } from "@/components/cursor-history-controls"
import { useCursorHistoryArchive } from "@/hooks/use-cursor-history-archive"
import { snapshotTotals, snapshotKey, historyDateTime, HISTORY_USD_FORMAT as USD_FORMAT } from "@/lib/cursor-history-summary"

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
  const { snapshot: current, loading, refreshing, stale: currentStale, error, unavailable } = useCursorHistory(
    providerId,
    accountId,
    demandRevision
  )
  const archive = useCursorHistoryArchive(providerId, accountId, current)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const snapshot = archive.snapshots.find((recorded) => snapshotKey(recorded) === selectedKey) ?? current
  const archived = snapshot !== null && current !== null && snapshotKey(snapshot) !== snapshotKey(current)
  const stale = !archived && currentStale
  const previous = snapshot ? archive.snapshots.find((recorded) =>
    recorded.coverage.fetchedAtMs < snapshot.coverage.fetchedAtMs
    && recorded.coverage.billingCycle?.startMs !== snapshot.coverage.billingCycle?.startMs
  ) : undefined
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
          : snapshot?.coverage.complete
            ? "Complete Pages"
            : null

  return (
    <section className="mt-4 space-y-3 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 items-center gap-2">
          <Activity className="size-4 shrink-0 text-muted-foreground" />
          <h3 className="whitespace-nowrap text-sm font-semibold">Model Usage</h3>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
          {snapshot && !archived && refreshing ? <Badge variant="outline">Cached</Badge> : null}
          {!archived && refreshing ? (
            <Badge variant="outline" className="gap-1">
              <RefreshCw className="size-3 animate-spin" />
              Refreshing
            </Badge>
          ) : null}
          {archived ? <Badge variant="outline">Stored Window</Badge> : null}
          {status ? <Badge variant="outline">{status}</Badge> : null}
        </div>
        <p className="w-full text-xs text-muted-foreground">当前 Cursor 会话可见的模型用量</p>
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
          {current ? <CursorHistoryControls providerId={providerId} accountId={accountId} current={current} selected={snapshot} recorded={archive.snapshots} onSelect={setSelectedKey} error={archive.error} /> : null}
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Session-Visible Usage</p>
              <p className="mt-1 text-sm font-medium">
                {formatCountNumber(totals.requests)} Requests ·{" "}
                {formatCountNumber(totals.tokens)} Tokens
              </p>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">List-Price Equivalent</p>
              <p className="mt-1 text-sm font-medium">
                {totals.knownListPriceBuckets > 0
                  ? USD_FORMAT.format(totals.listPrice)
                  : "Unavailable"}
              </p>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Metered Usage</p>
              <p className="mt-1 text-sm font-medium">
                {snapshot.totals.meteredChargedUsd === null
                  ? "Unavailable"
                  : USD_FORMAT.format(snapshot.totals.meteredChargedUsd)}
                {snapshot.totals.meteredCoverage === "incomplete" ? " · Incomplete" : null}
              </p>
            </div>
          </div>

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
          <CursorHistoryComparison selected={snapshot} previous={previous} />

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

          <div className="space-y-2">
            {models.map((model) => {
              const totalTokens =
                model.inputTokens +
                model.outputTokens +
                model.cacheWriteTokens +
                model.cacheReadTokens
              return (
                <div
                  key={model.modelName}
                  className="rounded-md border border-border p-3"
                >
                  <h4 className="truncate text-sm font-medium">
                    {model.modelName.trim().length === 0 ? "Unknown" : model.modelName}
                  </h4>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>Total Tokens {formatCountNumber(totalTokens)}</span>
                    <span>Input {formatCountNumber(model.inputTokens)}</span>
                    <span>Output {formatCountNumber(model.outputTokens)}</span>
                    <span>Cache Write {formatCountNumber(model.cacheWriteTokens)}</span>
                    <span>Cache Read {formatCountNumber(model.cacheReadTokens)}</span>
                    <span>{formatCountNumber(model.requestCount)} Requests</span>
                    <span>
                      List Price{" "}
                      {model.knownListCostUsd === null
                        ? "Unavailable"
                        : USD_FORMAT.format(model.knownListCostUsd)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </section>
  )
}
