import { invoke } from "@tauri-apps/api/core"
import type { MetricLine } from "@/lib/plugin-types"

export type LocalHistorySnapshot = {
  providerId: string
  accountId: string | null
  fetchedAt: string
  lines: Extract<MetricLine, { type: "text" | "barChart" }>[]
}

export function refreshLocalHistory(providerId: string, accountId: string | null) {
  return invoke<LocalHistorySnapshot>("refresh_local_history", { providerId, accountId })
}
