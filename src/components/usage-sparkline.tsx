import { useState, type CSSProperties } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn, clamp01, formatCountNumber } from "@/lib/utils"
import type { BarChartPoint } from "@/lib/plugin-types"

type UsageSparklineProps = {
  label: string
  points: BarChartPoint[]
  note?: string
  color?: string
  dateRange?: { fromDate: string; toDate: string }
}

const pointLabel = (point: BarChartPoint) => point.valueLabel ?? formatCountNumber(point.value)
type ChartSlot = BarChartPoint | { label: string; value: null }
const slotLabel = (slot: ChartSlot) => slot.value === null ? "未报告" : pointLabel(slot)
const MISSING_STYLE: CSSProperties = {
  height: "100%",
  backgroundImage: "repeating-linear-gradient(135deg, transparent, transparent 2px, currentColor 2px, currentColor 3px)",
  opacity: 0.25,
}

// Inline, glanceable usage history that matches the card's row rhythm.
// Hover/focus reveals a larger, readable graph (detail-on-demand); hovering a
// day's bar in that graph shows exactly how much was used that day.
export function UsageSparkline({ label, points, note, color, dateRange }: UsageSparklineProps) {
  const valid = points.filter((point) => Number.isFinite(point.value) && point.value >= 0)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const slots: ChartSlot[] = dateRange ? [] : valid
  if (dateRange) {
    const byDate = new Map(valid.map((point) => [point.label, point]))
    const end = Date.parse(dateRange.toDate + "T00:00:00Z")
    for (let day = Date.parse(dateRange.fromDate + "T00:00:00Z"); day <= end; day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10)
      slots.push(byDate.get(date) ?? { label: date, value: null })
    }
  }
  if (slots.length === 0) return null

  const maxValue = Math.max(1, ...valid.map((point) => point.value))
  const peak = valid.length ? valid.reduce((a, b) => (b.value > a.value ? b : a)) : null
  const last = valid[valid.length - 1]
  const missing = slots.filter((slot) => slot.value === null).length
  const summary = `${label}：共 ${slots.length} 天${missing ? `，${missing} 天未报告` : ""}${last && peak ? `，最近 ${pointLabel(last)}（${last.label}），峰值 ${pointLabel(peak)}` : "，暂无已报告数据"}。${note ? ` ${note}` : ""}`

  // Default readout = peak; hovering a bar shows that specific day.
  const active = activeIndex != null ? slots[activeIndex] : null
  const readout = active ? `${active.label} · ${slotLabel(active)}` : peak ? `峰值 ${pointLabel(peak)}` : "暂无已报告数据"

  const barStyle = (point: BarChartPoint, minPercent: number): CSSProperties => {
    const ratio = clamp01(point.value / maxValue)
    const height = point.value > 0 ? Math.max(minPercent, ratio * 100) : minPercent / 2
    const style: CSSProperties = { height: `${height}%` }
    if (color) style.backgroundColor = color
    return style
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            aria-label={summary}
            className="flex h-[18px] w-full items-center justify-between gap-2 rounded-sm border-0 bg-transparent p-0 text-left outline-none [touch-action:manipulation] focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
            <span
              aria-hidden
              className="flex h-4 w-1/2 max-w-[150px] flex-shrink-0 items-end justify-end gap-px"
            >
              {slots.map((point, index) => (
                <span
                  key={`${point.label}-${index}`}
                  data-date={point.label}
                  data-missing={point.value === null || undefined}
                  className={cn("min-w-[2px] flex-1 rounded-[1px]", point.value !== null && "bg-primary")}
                  style={point.value === null ? MISSING_STYLE : barStyle(point, 10)}
                />
              ))}
            </span>
          </button>
        )}
      />
      <TooltipContent side="top" className="w-56" onMouseLeave={() => setActiveIndex(null)}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium">{label}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">{readout}</span>
        </div>
        <div className="mt-1.5 flex h-20 items-end gap-px">
          {slots.map((point, index) => (
            // Full-height column is the hover/focus target so even short bars
            // are easy to hit with a pointer or keyboard.
            <button
              key={`${point.label}-${index}`}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              title={`${point.label}: ${slotLabel(point)}`}
              aria-label={`${point.label}: ${slotLabel(point)}`}
              className="flex h-full min-w-[3px] flex-1 items-end border-0 bg-transparent p-0 outline-none [touch-action:manipulation] focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "w-full rounded-[1px] transition-opacity",
                  point.value !== null && "bg-primary",
                  activeIndex != null && index !== activeIndex && "opacity-40"
                )}
                style={point.value === null ? MISSING_STYLE : barStyle(point, 6)}
              />
            </button>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{slots[0].label}</span>
          <span>{slots[slots.length - 1].label}</span>
        </div>
        {note && <div className="mt-1 text-[10px] text-muted-foreground">{note}</div>}
      </TooltipContent>
    </Tooltip>
  )
}
