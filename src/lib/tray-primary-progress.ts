import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"

type PluginState = {
  data: PluginOutput | null
  loading: boolean
  error: string | null
}

export type TrayPrimaryBar = {
  id: string
  fraction?: number
}

type ProgressLine = Extract<
  PluginOutput["lines"][number],
  { type: "progress"; label: string; value: number; max: number }
>

function isProgressLine(line: PluginOutput["lines"][number]): line is ProgressLine {
  return line.type === "progress"
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function getTrayPrimaryBars(args: {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState | undefined>
  maxBars?: number
}): TrayPrimaryBar[] {
  const { pluginsMeta, pluginSettings, pluginStates, maxBars = 4 } = args
  if (!pluginSettings) return []

  const metaById = new Map(pluginsMeta.map((p) => [p.id, p]))
  const disabled = new Set(pluginSettings.disabled)

  const out: TrayPrimaryBar[] = []
  for (const id of pluginSettings.order) {
    if (disabled.has(id)) continue
    const meta = metaById.get(id)
    if (!meta) continue
    const primaryLabel = meta.primaryProgressLabel ?? null
    if (!primaryLabel) continue

    const state = pluginStates[id]
    const data = state?.data ?? null

    let fraction: number | undefined
    if (data) {
      const primaryLine = data.lines.find(
        (line): line is ProgressLine =>
          isProgressLine(line) && line.label === primaryLabel
      )
      if (primaryLine && primaryLine.max > 0) {
        fraction = clamp01(primaryLine.value / primaryLine.max)
      }
    }

    out.push({ id, fraction })
    if (out.length >= maxBars) break
  }

  return out
}

