import { Badge } from "@/components/ui/badge"
import { UsageSparkline } from "@/components/usage-sparkline"
import { QuotaMetric } from "@/components/quota-metric"
import type { MetricLine } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

/** Dispatches provider metrics while passing freshness and reset controls to quota displays. */
export function MetricLineRenderer({ line, ...props }: {
  line: MetricLine
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  now: number
  refreshing?: boolean
  stale?: boolean
  lastUpdatedAt?: number | null
}) {
  if (line.type === "progress") return <QuotaMetric line={line} {...props} />
  if (line.type === "barChart") return <UsageSparkline {...line} />
  if (line.type === "badge") {
    return (
      <div>
        <div className="flex justify-between items-center h-[22px]">
          <span className="text-sm text-muted-foreground flex-shrink-0">{line.label}</span>
          <Badge variant="outline" className="truncate min-w-0 max-w-[60%]"
            style={line.color ? { color: line.color, borderColor: line.color } : undefined} title={line.text}>
            {line.text}
          </Badge>
        </div>
        {line.subtitle ? <div className="text-xs text-muted-foreground text-right -mt-0.5">{line.subtitle}</div> : null}
      </div>
    )
  }
  return (
    <div>
      <div className="flex justify-between items-center h-[18px] gap-2">
        <span className="text-xs text-muted-foreground min-w-0 flex-1 truncate" title={line.label}>{line.label}</span>
        <span className="text-xs text-muted-foreground min-w-0 truncate max-w-[70%] text-right"
          style={line.color ? { color: line.color } : undefined} title={line.value}>{line.value}</span>
      </div>
      {line.subtitle ? <div className="text-[10px] text-muted-foreground text-right -mt-0.5"
        style={line.color ? { color: line.color } : undefined}>{line.subtitle}</div> : null}
    </div>
  )
}
