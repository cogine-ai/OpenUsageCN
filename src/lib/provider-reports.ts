import { invoke } from "@tauri-apps/api/core"
import type { MetricLine } from "@/lib/plugin-types"

export type ProviderReportStatus = "ready" | "partial" | "notSupported" | "permissionDenied" | "rateLimited" | "authExpired" | "error"

export type ProviderReportSection = {
  id: string
  label: string
  status: ProviderReportStatus
  message?: string
  retryAt?: string
  coverage?: {
    fromDate: string
    toDate: string
    timeZone: string
    reportedDates: string[]
    missingDates: string[]
  }
}

export type ProviderReportsSnapshot = {
  providerId: string
  requestId: string
  scopeKey: string
  fetchedAt: string
  lines: Extract<MetricLine, { type: "text" | "barChart" }>[]
  reports: ProviderReportSection[]
}

export function refreshProviderReports(providerId: string, requestId: string, connectionId?: string, useLegacy = false) {
  return invoke<ProviderReportsSnapshot>("refresh_provider_reports", { providerId, requestId, ...(connectionId ? { connectionId } : {}), ...(useLegacy ? { useLegacy: true } : {}) })
}

export function cancelProviderReports(providerId: string, requestId: string) {
  return invoke<void>("cancel_provider_reports", { providerId, requestId })
}
