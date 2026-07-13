import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"
import { DEFAULT_DISPLAY_MODE, type DisplayMode } from "@/lib/settings"
import { clamp01 } from "@/lib/utils"

type PluginState = {
  data: PluginOutput | null
  loading: boolean
  error: string | null
}

export type TrayPrimaryBar = {
  id: string
  fraction?: number
  /** Label of the metric line that produced this bar (when data is available). */
  label?: string
  /** True when the value came from the provider's declared weekly line. */
  weekly?: boolean
}

type ProgressLine = Extract<
  PluginOutput["lines"][number],
  { type: "progress"; label: string; used: number; limit: number }
>

function isProgressLine(line: PluginOutput["lines"][number]): line is ProgressLine {
  return line.type === "progress"
}

export function getTrayPrimaryBars(args: {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState | undefined>
  maxBars?: number
  displayMode?: DisplayMode
  pluginId?: string
  preferWeekly?: boolean
}): TrayPrimaryBar[] {
  const {
    pluginsMeta,
    pluginSettings,
    pluginStates,
    maxBars = 4,
    displayMode = DEFAULT_DISPLAY_MODE,
    pluginId,
    preferWeekly = false,
  } = args
  if (!pluginSettings) return []

  const metaById = new Map(pluginsMeta.map((p) => [p.id, p]))
  const disabled = new Set(pluginSettings.disabled)
  const orderedIds = pluginId
    ? [pluginId]
    : pluginSettings.order

  const out: TrayPrimaryBar[] = []
  for (const id of orderedIds) {
    if (disabled.has(id)) continue
    const meta = metaById.get(id)
    if (!meta) continue
    
    // Providers still need a declared primary metric to appear in the menubar.
    // When that metric is temporarily absent from the current response, the
    // selection below can fall back to the provider's declared weekly metric.
    if (!meta.primaryCandidates || meta.primaryCandidates.length === 0) continue

    const state = pluginStates[id]
    const data = state?.data ?? null

    let fraction: number | undefined
    let label: string | undefined
    let weekly: true | undefined
    if (data) {
      const weeklyLabel =
        meta.weeklyCandidate !== undefined &&
        data.lines.some(
          (line) => isProgressLine(line) && line.label === meta.weeklyCandidate
        )
          ? meta.weeklyCandidate
          : undefined
      const primaryLabel = meta.primaryCandidates.find((candidate) =>
        data.lines.some((line) => isProgressLine(line) && line.label === candidate)
      )
      const metricLabel = preferWeekly
        ? weeklyLabel ?? primaryLabel
        : primaryLabel ?? weeklyLabel
      const usesWeekly = weeklyLabel !== undefined && metricLabel === weeklyLabel

      if (metricLabel) {
        label = metricLabel
        weekly = usesWeekly || undefined
        const metricLine = data.lines.find(
          (line): line is ProgressLine =>
            isProgressLine(line) && line.label === metricLabel
        )
        if (metricLine && metricLine.limit > 0) {
          const shownAmount =
            displayMode === "used"
              ? metricLine.used
              : metricLine.limit - metricLine.used
          fraction = clamp01(shownAmount / metricLine.limit)
        }
      }
    }

    out.push({ id, fraction, label, weekly })
    if (out.length >= maxBars) break
  }

  return out
}
