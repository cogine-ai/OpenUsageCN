import { calculatePaceStatus, type PaceStatus } from "@/lib/pace-status"

export type QuotaForecast = {
  state: PaceStatus | "exhausted" | "early" | "unavailable" | "resetting" | "stale" | "refreshing"
  depletionFraction?: number
  depletionInMs?: number
  remainingAtReset?: number
}

/** Predict from valid current-cycle data only, separating stale, early, and exhausted states. */
export function quotaForecast({ used, limit, resetsAtMs, periodDurationMs, now, stale, refreshing }: {
  used: number
  limit: number
  resetsAtMs: number
  periodDurationMs?: number
  now: number
  stale?: boolean
  refreshing?: boolean
}): QuotaForecast {
  if (stale) return { state: "stale" }
  if (refreshing) return { state: "refreshing" }
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return { state: "unavailable" }
  if (Number.isFinite(resetsAtMs) && resetsAtMs <= now) return { state: "resetting" }
  if (used >= limit) return { state: "exhausted", depletionFraction: 0 }
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(periodDurationMs) || periodDurationMs! <= 0) {
    return { state: "unavailable" }
  }
  const result = calculatePaceStatus(used, limit, resetsAtMs, periodDurationMs!, now)
  if (!result) {
    const elapsed = now - (resetsAtMs - periodDurationMs!)
    return { state: elapsed > 0 && elapsed / periodDurationMs! < 0.05 ? "early" : "unavailable" }
  }
  if (result.status !== "behind") {
    return { state: result.status, remainingAtReset: Math.max(0, 100 - result.projectedUsage / limit * 100) }
  }
  const depletionInMs = (limit - used) / (result.projectedUsage / periodDurationMs!)
  return {
    state: result.status,
    depletionInMs,
    depletionFraction: depletionInMs / (resetsAtMs - now),
  }
}
