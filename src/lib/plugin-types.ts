export type ProgressFormat =
  | { kind: "percent" }
  | { kind: "dollars" }
  | { kind: "count"; suffix: string }

export type BarChartPoint = {
  label: string
  value: number
  valueLabel?: string
}

export type MetricLine =
  | { type: "text"; label: string; value: string; color?: string; subtitle?: string }
  | {
      type: "progress"
      label: string
      used: number
      limit: number
      format: ProgressFormat
      resetsAt?: string
      periodDurationMs?: number
      color?: string
    }
  | { type: "badge"; label: string; text: string; color?: string; subtitle?: string }
  | { type: "barChart"; label: string; points: BarChartPoint[]; note?: string; color?: string }

export type ManifestLine = {
  type: "text" | "progress" | "badge" | "barChart"
  label: string
  scope: "overview" | "detail"
}

export type PluginLink = {
  label: string
  url: string
}

export type PluginStatusPage = {
  url: string
}

export type ProviderStatus = {
  level: "operational" | "degraded" | "outage"
  description: string
  updatedAt: string | null
}

export type PluginConfigFieldType = "secret" | "text" | "select" | "toggle"

export type PluginConfigOption = {
  value: string
  label: string
}

export type PluginConfigField = {
  id: string
  type: PluginConfigFieldType
  label: string
  placeholder?: string
  help?: string
  options: PluginConfigOption[]
  default?: unknown
  defaultSource?: boolean
}

export type PluginConfig = {
  fields: PluginConfigField[]
}

export type PluginOutput = {
  providerId: string
  displayName: string
  plan?: string
  lines: MetricLine[]
  iconUrl: string
}

export type PluginAccountSupport = {
  localDiscovery: boolean
  browserBinding: boolean
  modelHistory: boolean
}

export type PluginMeta = {
  id: string
  name: string
  iconUrl: string
  brandColor?: string
  lines: ManifestLine[]
  links?: PluginLink[]
  statusPage?: PluginStatusPage
  config?: PluginConfig
  accountSupport?: PluginAccountSupport
  /** Ordered list of primary metric candidates. Frontend picks first available. */
  primaryCandidates: string[]
  /** Label of the line marked `"period": "weekly"`, if the provider has one. */
  weeklyCandidate?: string
}

export type PluginDisplayState = {
  meta: PluginMeta
  data: PluginOutput | null
  loading: boolean
  error: string | null
  lastManualRefreshAt: number | null
  lastUpdatedAt: number | null
}
