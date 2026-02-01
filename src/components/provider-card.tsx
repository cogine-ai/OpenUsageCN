import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { SkeletonLines } from "@/components/skeleton-lines"
import { PluginError } from "@/components/plugin-error"
import type { ManifestLine, MetricLine } from "@/lib/plugin-types"

interface ProviderCardProps {
  name: string
  iconUrl: string
  showSeparator?: boolean
  loading?: boolean
  error?: string | null
  lines?: MetricLine[]
  skeletonLines?: ManifestLine[]
  onRetry?: () => void
}

function formatNumber(value: number) {
  if (Number.isNaN(value)) return "0"
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

function formatProgressValue(value: number, unit?: "percent" | "dollars") {
  if (!Number.isFinite(value) || value < 0) {
    console.error("Invalid progress value:", value)
    return "N/A"
  }
  if (unit === "percent") {
    return `${Math.round(value)}%`
  }
  if (unit === "dollars") {
    return `$${formatNumber(value)}`
  }
  return formatNumber(value)
}

function getProgressPercent(value: number, max: number) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(100, Math.max(0, (value / max) * 100))
}

export function ProviderCard({
  name,
  iconUrl,
  showSeparator = true,
  loading = false,
  error = null,
  lines = [],
  skeletonLines = [],
  onRetry,
}: ProviderCardProps) {
  return (
    <div>
      <div className="py-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">{name}</h2>
          <img
            src={iconUrl}
            alt=""
            className="w-5 h-5 opacity-60"
          />
        </div>
        {error && (
          <PluginError message={error} onRetry={onRetry} />
        )}

        {loading && !error && (
          <SkeletonLines lines={skeletonLines} />
        )}

        {!loading && !error && (
          <div className="space-y-1">
            {lines.map((line, index) => (
              <MetricLineRenderer key={`${line.label}-${index}`} line={line} />
            ))}
          </div>
        )}
      </div>
      {showSeparator && <Separator />}
    </div>
  )
}

function MetricLineRenderer({ line }: { line: MetricLine }) {
  if (line.type === "text") {
    return (
      <div className="flex justify-between items-center h-[22px]">
        <span className="text-sm text-muted-foreground">{line.label}</span>
        <span
          className="text-sm text-muted-foreground"
          style={line.color ? { color: line.color } : undefined}
        >
          {line.value}
        </span>
      </div>
    )
  }

  if (line.type === "badge") {
    return (
      <div className="flex justify-between items-center h-[22px]">
        <span className="text-sm text-muted-foreground">{line.label}</span>
        <Badge
          variant="outline"
          style={
            line.color
              ? { color: line.color, borderColor: line.color }
              : undefined
          }
        >
          {line.text}
        </Badge>
      </div>
    )
  }

  if (line.type === "progress") {
    const percent = getProgressPercent(line.value, line.max)
    return (
      <div className="flex justify-between items-center h-[22px]">
        <span className="text-sm text-muted-foreground">{line.label}</span>
        <div className="flex items-center gap-2">
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatProgressValue(line.value, line.unit)}
          </span>
          <Progress
            className="w-24"
            value={percent}
            indicatorColor={line.color}
          />
        </div>
      </div>
    )
  }

  return null
}
