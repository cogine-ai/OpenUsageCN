import { Activity, AlertTriangle, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { useCursorHistory } from "@/hooks/use-cursor-history"
import type { CompleteHistory, CursorHistoryListCostCoverage } from "@/lib/cursor-history"
import { formatCountNumber } from "@/lib/utils"

const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

type CursorModelUsageProps = {
  providerId: string
  accountId: string
  demandRevision?: number
}

function snapshotTotals(snapshot: CompleteHistory) {
  let tokens = 0
  let requests = 0
  let listPrice = 0
  let knownListPriceBuckets = 0
  let partialListPrice = false

  for (const bucket of snapshot.buckets) {
    tokens +=
      bucket.inputTokens +
      bucket.outputTokens +
      bucket.cacheWriteTokens +
      bucket.cacheReadTokens
    requests += bucket.requestCount
    if (bucket.knownListCostUsd === null) {
      partialListPrice = true
    } else {
      listPrice += bucket.knownListCostUsd
      knownListPriceBuckets += 1
    }
    if (bucket.listCostCoverage !== "complete") partialListPrice = true
  }

  return { tokens, requests, listPrice, knownListPriceBuckets, partialListPrice }
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

function zonedParts(valueMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(valueMs))
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function zonedDate(valueMs: number, timeZone: string): string {
  const parts = zonedParts(valueMs, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function zonedDateTime(valueMs: number, timeZone: string): string {
  const parts = zonedParts(valueMs, timeZone)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function CursorModelUsage({
  providerId,
  accountId,
  demandRevision = 0,
}: CursorModelUsageProps) {
  const { snapshot, loading, refreshing, stale, error, unavailable } = useCursorHistory(
    providerId,
    accountId,
    demandRevision
  )
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
            ? "Complete"
            : null

  return (
    <section className="mt-4 space-y-3 rounded-lg border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Activity className="mt-0.5 size-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Model Usage</h3>
            <p className="text-xs text-muted-foreground">当前 Cursor 会话可见的模型用量</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {snapshot && refreshing ? <Badge variant="outline">Cached</Badge> : null}
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
              Coverage {zonedDate(snapshot.coverage.fromMs, snapshot.coverage.timeZone)} –{" "}
              {zonedDate(snapshot.coverage.toMs, snapshot.coverage.timeZone)}
            </span>
            <span>
              Updated {zonedDateTime(snapshot.coverage.fetchedAtMs, snapshot.coverage.timeZone)} ·{" "}
              {snapshot.coverage.timeZone}
            </span>
          </div>

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
