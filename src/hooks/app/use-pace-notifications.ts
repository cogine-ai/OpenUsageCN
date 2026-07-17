import { useCallback, useEffect, useRef } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import type { PluginMeta } from "@/lib/plugin-types"
import {
  getEnabledPluginIds,
  type PaceNotificationSettings,
  type PluginSettings,
} from "@/lib/settings"
import type { PluginState } from "@/hooks/app/types"
import {
  commitDeliveredPaceNotifications,
  createPaceNotificationState,
  evaluatePaceNotification,
  type PaceNotificationMilestone,
  type PaceNotificationState,
} from "@/lib/pace-notification-logic"

const LOCAL_EVALUATION_INTERVAL_MS = 5 * 60_000

type UsePaceNotificationsArgs = {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState>
  settings: PaceNotificationSettings
}

const notificationCopy: Record<
  PaceNotificationMilestone,
  { title: string; body: string }
> = {
  almostOut: { title: "即将用尽", body: "当前周期的额度剩余不足 10%。" },
  closeToLimit: { title: "接近上限", body: "按当前速度，预计将在重置前接近额度上限。" },
  runningOut: { title: "预计提前用尽", body: "按当前速度，额度预计会在重置前耗尽。" },
}

export function usePaceNotifications({
  pluginsMeta,
  pluginSettings,
  pluginStates,
  settings,
}: UsePaceNotificationsArgs) {
  const statesRef = useRef(new Map<string, PaceNotificationState>())
  const inputsRef = useRef({ pluginsMeta, pluginSettings, pluginStates, settings })
  const queueRef = useRef(Promise.resolve())
  const successfulRevisionsRef = useRef(new Map<string, number | null>())

  useEffect(() => {
    inputsRef.current = { pluginsMeta, pluginSettings, pluginStates, settings }
  }, [pluginSettings, pluginStates, pluginsMeta, settings])

  const evaluate = useCallback(() => {
    queueRef.current = queueRef.current.then(async () => {
      const inputs = inputsRef.current
      const names = new Map(inputs.pluginsMeta.map((plugin) => [plugin.id, plugin.name]))
      const enabledIds = new Set(
        inputs.pluginSettings ? getEnabledPluginIds(inputs.pluginSettings) : []
      )
      const seen = new Set<string>()
      const nowMs = Date.now()

      for (const [providerId, pluginState] of Object.entries(inputs.pluginStates)) {
        if (!enabledIds.has(providerId) || !pluginState.data) continue
        const labelOccurrences = new Map<string, number>()
        for (const line of pluginState.data.lines) {
          if (
            line.type !== "progress" ||
            !Number.isFinite(line.used) ||
            !Number.isFinite(line.limit) ||
            line.used < 0 ||
            line.limit <= 0
          ) continue

          // Key by label + same-label occurrence so inserting/removing an
          // unrelated progress line (e.g. Claude Sonnet, Cursor Bonus spend)
          // does not drop paced state for later metrics.
          const occurrence = labelOccurrences.get(line.label) ?? 0
          labelOccurrences.set(line.label, occurrence + 1)
          const key = `${providerId}:${line.label}:${occurrence}`
          seen.add(key)
          const resetsAtMs = line.resetsAt ? Date.parse(line.resetsAt) : null
          const evaluation = evaluatePaceNotification(
            {
              used: line.used,
              limit: line.limit,
              resetsAtMs: resetsAtMs !== null && Number.isFinite(resetsAtMs) ? resetsAtMs : null,
              periodDurationMs: line.periodDurationMs ?? null,
              nowMs,
            },
            statesRef.current.get(key) ?? createPaceNotificationState(),
            inputs.settings
          )

          const delivered = new Set<PaceNotificationMilestone>()
          for (const milestone of evaluation.candidates) {
            if (!isTauri()) continue
            const copy = notificationCopy[milestone]
            try {
              await invoke("post_pace_notification", {
                title: copy.title,
                subtitle: `${names.get(providerId) ?? pluginState.data.displayName} · ${line.label}`,
                body: copy.body,
              })
              delivered.add(milestone)
            } catch (error) {
              console.error(`Failed to post ${milestone} pace notification:`, error)
            }
          }
          statesRef.current.set(
            key,
            commitDeliveredPaceNotifications(evaluation, delivered)
          )
        }
      }

      for (const key of statesRef.current.keys()) {
        if (!seen.has(key)) statesRef.current.delete(key)
      }
    }).catch((error) => {
      console.error("Failed to evaluate pace notifications:", error)
    })
  }, [])

  useEffect(() => {
    let hasNewSuccessfulData = false
    const currentIds = new Set(Object.keys(pluginStates))
    for (const [providerId, state] of Object.entries(pluginStates)) {
      const previousRevision = successfulRevisionsRef.current.get(providerId)
      if (state.lastUpdatedAt !== null && state.lastUpdatedAt !== previousRevision) {
        successfulRevisionsRef.current.set(providerId, state.lastUpdatedAt)
        hasNewSuccessfulData = true
      }
    }
    for (const providerId of successfulRevisionsRef.current.keys()) {
      if (!currentIds.has(providerId)) successfulRevisionsRef.current.delete(providerId)
    }
    if (hasNewSuccessfulData) evaluate()
  }, [evaluate, pluginStates])

  useEffect(() => {
    // Re-evaluate when a previously disabled trigger is enabled. Disabled
    // edges are intentionally not consumed by the pure state machine.
    evaluate()
  }, [evaluate, pluginSettings, settings])

  useEffect(() => {
    const timer = window.setInterval(evaluate, LOCAL_EVALUATION_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [evaluate])
}
