import { calculatePaceStatus } from "@/lib/pace-status"
import type { PaceNotificationSettings } from "@/lib/settings"

export type PaceNotificationMilestone = "almostOut" | "closeToLimit" | "runningOut"
export type PaceNotificationBucket = "untracked" | "ahead" | "on-track" | "behind"

export type PaceNotificationState = {
  resetsAtMs: number | null
  fired: Set<PaceNotificationMilestone>
  previousBucket: PaceNotificationBucket
  wasUnderTenPercent: boolean
  primed: boolean
  remainingPrimed: boolean
}

export type PaceNotificationObservation = {
  used: number
  limit: number
  resetsAtMs: number | null
  periodDurationMs: number | null
  nowMs: number
}

export type PaceNotificationEvaluation = {
  candidates: PaceNotificationMilestone[]
  nextState: PaceNotificationState
  currentBucket: PaceNotificationBucket
  underTenPercent: boolean
}

export function createPaceNotificationState(): PaceNotificationState {
  return {
    resetsAtMs: null,
    fired: new Set(),
    previousBucket: "untracked",
    wasUnderTenPercent: false,
    primed: false,
    remainingPrimed: false,
  }
}

export function evaluatePaceNotification(
  observation: PaceNotificationObservation,
  previous: PaceNotificationState,
  settings: PaceNotificationSettings
): PaceNotificationEvaluation {
  const next = cloneState(previous)
  const currentBucket = bucketForObservation(observation)
  const underTenPercent = observation.used > observation.limit * 0.9

  if (resetWindowAdvanced(previous.resetsAtMs, observation.resetsAtMs, observation.nowMs)) {
    next.fired.clear()
    next.previousBucket = "untracked"
    next.wasUnderTenPercent = false
    next.primed = false
    next.remainingPrimed = false
    next.resetsAtMs = observation.resetsAtMs
  } else if (next.resetsAtMs === null && observation.resetsAtMs !== null) {
    next.resetsAtMs = observation.resetsAtMs
  }

  const candidates: PaceNotificationMilestone[] = []
  const primePace = !next.primed && currentBucket !== "untracked"
  if (primePace) {
    next.primed = true
    next.previousBucket = currentBucket
  }
  const previousSeverity = bucketSeverity(next.previousBucket)
  const currentSeverity = bucketSeverity(currentBucket)
  let paceEdgePending = false

  // Missing reset metadata is not recovery. Preserve the last computable pace
  // bucket and its delivered edges until a real pace observation returns.
  if (next.primed && !primePace && currentBucket !== "untracked") {
    if (currentBucket === "behind" && previousSeverity < bucketSeverity("behind")) {
      paceEdgePending = !next.fired.has("runningOut")
      if (paceEdgePending && settings.runningOut) candidates.push("runningOut")
    } else if (currentBucket === "on-track" && previousSeverity < bucketSeverity("on-track")) {
      paceEdgePending = !next.fired.has("closeToLimit")
      if (paceEdgePending && settings.closeToLimit) candidates.push("closeToLimit")
    }

    if (currentSeverity < previousSeverity) {
      if (currentSeverity <= bucketSeverity("ahead")) next.fired.delete("closeToLimit")
      if (currentSeverity <= bucketSeverity("on-track")) next.fired.delete("runningOut")
      next.previousBucket = currentBucket
    } else if (!paceEdgePending || next.fired.has(currentBucket === "behind" ? "runningOut" : "closeToLimit")) {
      next.previousBucket = currentBucket
    }
  }

  if (!next.remainingPrimed) {
    next.remainingPrimed = true
    next.wasUnderTenPercent = underTenPercent
  } else {
    const crossedUnderTen = underTenPercent && !next.wasUnderTenPercent
    if (!underTenPercent) {
      next.wasUnderTenPercent = false
      next.fired.delete("almostOut")
    } else if (next.fired.has("almostOut")) {
      next.wasUnderTenPercent = true
    } else if (crossedUnderTen && settings.almostOut) {
      candidates.push("almostOut")
    }
  }

  return { candidates, nextState: next, currentBucket, underTenPercent }
}

export function commitDeliveredPaceNotifications(
  evaluation: PaceNotificationEvaluation,
  delivered: Set<PaceNotificationMilestone>
): PaceNotificationState {
  const next = cloneState(evaluation.nextState)
  for (const milestone of delivered) next.fired.add(milestone)
  if (delivered.has("closeToLimit") || delivered.has("runningOut")) {
    next.previousBucket = evaluation.currentBucket
  }
  if (delivered.has("almostOut")) next.wasUnderTenPercent = evaluation.underTenPercent
  return next
}

function bucketForObservation(
  observation: PaceNotificationObservation
): PaceNotificationBucket {
  if (
    observation.resetsAtMs === null ||
    observation.periodDurationMs === null
  ) {
    return observation.used >= observation.limit ? "behind" : "untracked"
  }
  return calculatePaceStatus(
    observation.used,
    observation.limit,
    observation.resetsAtMs,
    observation.periodDurationMs,
    observation.nowMs
  )?.status ?? "untracked"
}

function resetWindowAdvanced(
  previousResetMs: number | null,
  currentResetMs: number | null,
  nowMs: number
): boolean {
  if (previousResetMs === null || currentResetMs === null) return false
  return previousResetMs <= nowMs && currentResetMs > previousResetMs + 1_000
}

function bucketSeverity(bucket: PaceNotificationBucket): number {
  if (bucket === "ahead") return 0
  if (bucket === "on-track") return 1
  if (bucket === "behind") return 2
  return -1
}

function cloneState(state: PaceNotificationState): PaceNotificationState {
  return { ...state, fired: new Set(state.fired) }
}
