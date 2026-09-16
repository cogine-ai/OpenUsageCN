import { invoke } from "@tauri-apps/api/core"

export type CursorHistoryListCostCoverage = "complete" | "partial" | "invalid"

export type CursorModelUsageBucket = {
  localDate: string
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requestCount: number
  knownListCostUsd: number | null
  listCostCoverage: CursorHistoryListCostCoverage
}

export type CursorHistoryCoverage = {
  fromMs: number
  toMs: number
  fetchedAtMs: number
  timeZone: string
  complete: boolean
  scope: "sessionVisible"
  billingCycle?: { startMs: number; endMs: number }
}

export type CursorHistoryTotals = {
  meteredChargedUsd: number | null
  meteredCoverage: "complete" | "incomplete"
}

export type CompleteHistory = {
  accountId: string
  buckets: CursorModelUsageBucket[]
  coverage: CursorHistoryCoverage
  totals: CursorHistoryTotals
}

export type CursorHistoryRefreshError = {
  code: string
  message: string
}

export type CursorHistoryRefreshResult = {
  snapshot: CompleteHistory | null
  stale: boolean
  error?: CursorHistoryRefreshError
}

export type CursorHistoryRefreshInput = {
  providerId: string
  accountId: string
  timeZone: string
}

export function getCursorHistorySnapshot(
  providerId: string,
  accountId: string
): Promise<CompleteHistory | null> {
  return invoke<CompleteHistory | null>("get_cursor_history_snapshot", {
    providerId,
    accountId,
  })
}

export function refreshCursorHistory(
  input: CursorHistoryRefreshInput
): Promise<CursorHistoryRefreshResult> {
  return invoke<CursorHistoryRefreshResult>("refresh_cursor_history", input)
}

export function exportCursorHistoryCsv(providerId: string, accountId: string, history: CompleteHistory): Promise<string> {
  const { fromMs, toMs, fetchedAtMs } = history.coverage
  return invoke<string>("export_cursor_history_csv", {
    providerId,
    accountId,
    snapshot: { fromMs, toMs, fetchedAtMs },
  })
}
