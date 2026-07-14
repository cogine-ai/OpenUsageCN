import { describe, expect, it } from "vitest"
import {
  commitDeliveredPaceNotifications,
  createPaceNotificationState,
  evaluatePaceNotification,
  type PaceNotificationObservation,
} from "@/lib/pace-notification-logic"

const allOn = { almostOut: true, closeToLimit: true, runningOut: true }
const hour = 3_600_000

function observation(
  used: number,
  nowMs = 5 * hour,
  resetsAtMs = 10 * hour
): PaceNotificationObservation {
  return { used, limit: 100, resetsAtMs, periodDurationMs: 10 * hour, nowMs }
}

function prime(value: PaceNotificationObservation) {
  return evaluatePaceNotification(value, createPaceNotificationState(), allOn).nextState
}

describe("pace notification logic", () => {
  it("primes an already-bad cold start without firing", () => {
    expect(evaluatePaceNotification(observation(96), createPaceNotificationState(), allOn).candidates)
      .toEqual([])
  })

  it("fires the three worsening edges", () => {
    const healthy = prime(observation(30))
    expect(evaluatePaceNotification(observation(45), healthy, allOn).candidates)
      .toEqual(["closeToLimit"])
    expect(evaluatePaceNotification(observation(60), healthy, allOn).candidates)
      .toEqual(["runningOut"])

    const aboveTen = prime(observation(89))
    expect(evaluatePaceNotification(observation(91), aboveTen, allOn).candidates)
      .toContain("almostOut")
  })

  it("does not treat exactly ten percent remaining as almost out", () => {
    const aboveTen = prime(observation(89))
    expect(evaluatePaceNotification(observation(90), aboveTen, allOn).candidates)
      .not.toContain("almostOut")
  })

  it("jumps from healthy to running out without the intermediate alert", () => {
    const evaluation = evaluatePaceNotification(observation(60), prime(observation(30)), allOn)
    expect(evaluation.candidates).toEqual(["runningOut"])
  })

  it("does not consume disabled or failed-delivery edges", () => {
    const healthy = prime(observation(30))
    const disabled = evaluatePaceNotification(observation(45), healthy, {
      ...allOn,
      closeToLimit: false,
    })
    expect(disabled.candidates).toEqual([])
    expect(disabled.nextState.previousBucket).toBe("ahead")

    const enabled = evaluatePaceNotification(observation(45), disabled.nextState, allOn)
    expect(enabled.candidates).toEqual(["closeToLimit"])
    expect(commitDeliveredPaceNotifications(enabled, new Set()).previousBucket).toBe("ahead")
  })

  it("dedupes a delivered alert until recovery", () => {
    const first = evaluatePaceNotification(observation(45), prime(observation(30)), allOn)
    const delivered = commitDeliveredPaceNotifications(first, new Set(["closeToLimit"]))
    expect(evaluatePaceNotification(observation(46), delivered, allOn).candidates).toEqual([])

    const recovered = evaluatePaceNotification(observation(30), delivered, allOn).nextState
    expect(evaluatePaceNotification(observation(45), recovered, allOn).candidates)
      .toEqual(["closeToLimit"])
  })

  it("ignores reset timestamp drift until the old window has elapsed", () => {
    const current = prime(observation(30, 5 * hour, 10 * hour))
    current.fired.add("closeToLimit")
    const drifted = evaluatePaceNotification(observation(45, 5 * hour, 10 * hour + 5_000), current, allOn)
    expect(drifted.nextState.fired.has("closeToLimit")).toBe(true)

    const nextWindow = evaluatePaceNotification(
      observation(45, 10 * hour + 1, 20 * hour),
      current,
      allOn
    )
    expect(nextWindow.nextState.fired.has("closeToLimit")).toBe(false)
  })

  it("preserves delivered pace edges while reset metadata is temporarily missing", () => {
    const first = evaluatePaceNotification(observation(60), prime(observation(30)), allOn)
    const delivered = commitDeliveredPaceNotifications(first, new Set(["runningOut"]))
    const missingMetadata = evaluatePaceNotification(
      { ...observation(60), resetsAtMs: null },
      delivered,
      allOn
    )

    expect(missingMetadata.nextState.previousBucket).toBe("behind")
    expect(missingMetadata.nextState.fired.has("runningOut")).toBe(true)
    expect(evaluatePaceNotification(observation(61), missingMetadata.nextState, allOn).candidates)
      .toEqual([])
  })

  it("primes the first computable pace observation after untracked data", () => {
    const untracked = evaluatePaceNotification(
      { ...observation(30), resetsAtMs: null },
      createPaceNotificationState(),
      allOn
    )
    expect(untracked.nextState.primed).toBe(false)
    expect(evaluatePaceNotification(observation(60), untracked.nextState, allOn).candidates)
      .toEqual([])
  })

  it("tracks the almost-out edge without pace metadata", () => {
    const withoutPace = (used: number): PaceNotificationObservation => ({
      ...observation(used),
      resetsAtMs: null,
      periodDurationMs: null,
    })
    const initial = evaluatePaceNotification(
      withoutPace(89),
      createPaceNotificationState(),
      allOn
    )

    expect(initial.candidates).toEqual([])
    expect(initial.nextState.primed).toBe(false)
    expect(initial.nextState.remainingPrimed).toBe(true)
    expect(evaluatePaceNotification(withoutPace(91), initial.nextState, allOn).candidates)
      .toEqual(["almostOut"])
  })
})
