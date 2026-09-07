import type { CompleteHistory } from "./cursor-history"

export const HISTORY_USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

export function snapshotTotals(snapshot: CompleteHistory) {
  let tokens = 0
  let requests = 0
  let listPrice = 0
  let knownListPriceBuckets = 0
  let partialListPrice = false
  for (const bucket of snapshot.buckets) {
    tokens += bucket.inputTokens + bucket.outputTokens + bucket.cacheWriteTokens + bucket.cacheReadTokens
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

export function snapshotKey(snapshot: CompleteHistory): string {
  const { fromMs, toMs, fetchedAtMs } = snapshot.coverage
  return `${fromMs}:${toMs}:${fetchedAtMs}`
}

export function historyDateTime(valueMs: number, timeZone: string, includeTime = false): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(valueMs))
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${date.year}-${date.month}-${date.day}${includeTime ? ` ${date.hour}:${date.minute}` : ""}`
}

export function historyWindowLabel(snapshot: CompleteHistory): string {
  const { billingCycle, timeZone } = snapshot.coverage
  if (!billingCycle) return "Unknown Billing Period"
  return `${historyDateTime(billingCycle.startMs, timeZone)} – ${historyDateTime(billingCycle.endMs, timeZone)}`
}

export function comparisonUnavailableReason(current: CompleteHistory, previous: CompleteHistory): string | null {
  const a = current.coverage
  const b = previous.coverage
  if (current.accountId !== previous.accountId || a.scope !== b.scope) return "账号或数据来源不同。"
  if (!a.complete || !b.complete) return "至少一个窗口的分页不完整。"
  if (a.timeZone !== b.timeZone) return "记录使用的时区不同。"
  if (!a.billingCycle || !b.billingCycle) return "至少一个窗口没有可靠账期。"
  if (a.toMs - a.fromMs !== b.toMs - b.fromMs
      || a.fromMs - a.billingCycle.startMs !== b.fromMs - b.billingCycle.startMs) {
    return "实际覆盖时长或账期内的位置不同。"
  }
  return null
}

export function percentageChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  return (current - previous) / previous * 100
}
