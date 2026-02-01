import { useEffect, useState } from "react"
import { Hourglass, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SkeletonLines } from "@/components/skeleton-lines"
import { PluginError } from "@/components/plugin-error"
import { cn } from "@/lib/utils"
import type { ManifestLine, MetricLine } from "@/lib/plugin-types"

const REFRESH_COOLDOWN_MS = 300_000 // 5 minutes

interface ProviderCardProps {
  name: string
  iconUrl: string
  showSeparator?: boolean
  loading?: boolean
  error?: string | null
  lines?: MetricLine[]
  skeletonLines?: ManifestLine[]
  lastManualRefreshAt?: number | null
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
  lastManualRefreshAt,
  onRetry,
}: ProviderCardProps) {
  const [now, setNow] = useState(Date.now())

  // Update "now" every second while in cooldown to keep UI in sync
  useEffect(() => {
    if (!lastManualRefreshAt) return
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastManualRefreshAt)
    if (remaining <= 0) return

    // Immediately sync "now" when entering cooldown
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [lastManualRefreshAt])

  const inCooldown = lastManualRefreshAt ? now - lastManualRefreshAt < REFRESH_COOLDOWN_MS : false
  const isDisabled = loading || inCooldown

  // Format remaining cooldown time as "Xm Ys"
  const formatRemainingTime = () => {
    if (!lastManualRefreshAt) return ""
    const remainingMs = REFRESH_COOLDOWN_MS - (now - lastManualRefreshAt)
    if (remainingMs <= 0) return ""
    const totalSeconds = Math.ceil(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
      return `Available in ${minutes}m ${seconds}s`
    }
    return `Available in ${seconds}s`
  }

  const tooltipText = loading
    ? "Refreshing..."
    : inCooldown
      ? formatRemainingTime()
      : "Refresh now"

  return (
    <div>
      <div className="py-3">
        <div className="flex items-center justify-between mb-2 group/header">
          <div className="relative flex items-center">
            <h2 className="text-lg font-semibold">{name}</h2>
            {onRetry && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.currentTarget.blur()
                      onRetry()
                    }}
                    className={cn(
                      "ml-1 opacity-40 group-hover/header:opacity-100 focus-visible:opacity-100",
                      isDisabled && "opacity-100"
                    )}
                    disabled={isDisabled}
                  >
                    {loading ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : inCooldown ? (
                      <Hourglass className="h-3 w-3" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {tooltipText}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
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
        <span className="text-sm text-muted-foreground flex-shrink-0">{line.label}</span>
        <span
          className="text-sm text-muted-foreground truncate min-w-0 max-w-[60%] text-right"
          style={line.color ? { color: line.color } : undefined}
          title={line.value}
        >
          {line.value}
        </span>
      </div>
    )
  }

  if (line.type === "badge") {
    return (
      <div className="flex justify-between items-center h-[22px]">
        <span className="text-sm text-muted-foreground flex-shrink-0">{line.label}</span>
        <Badge
          variant="outline"
          className="truncate min-w-0 max-w-[60%]"
          style={
            line.color
              ? { color: line.color, borderColor: line.color }
              : undefined
          }
          title={line.text}
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
