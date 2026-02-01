export type MetricLine =
  | { type: "text"; label: string; value: string; color?: string }
  | { type: "progress"; label: string; value: number; max: number; unit?: "percent" | "dollars"; color?: string }
  | { type: "badge"; label: string; text: string; color?: string }

export type PluginOutput = {
  providerId: string
  displayName: string
  lines: MetricLine[]
}

export type PluginMeta = {
  id: string
  name: string
}
