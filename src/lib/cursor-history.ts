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
  nowMs: number
  timeZone: string
  utcOffsetSeconds: number
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
