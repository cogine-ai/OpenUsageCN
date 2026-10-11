import { CalendarClock, Clock3, Timer } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { calculateDeficit } from "@/lib/pace-status"
import { formatCompactDuration, formatDeficitText, getPaceStatusText } from "@/lib/pace-tooltip"
import { quotaForecast, type QuotaForecast } from "@/lib/quota-forecast"
import { formatResetAbsoluteLabel, formatResetRelativeLabel, formatResetTooltipText } from "@/lib/reset-tooltip"
import { clamp01, formatCountNumber, formatFixedPrecisionNumber } from "@/lib/utils"
import type { MetricLine } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

function forecastLabel(forecast: QuotaForecast) {
  if (forecast.state === "behind") return `预计 ${formatCompactDuration(forecast.depletionInMs!)}后用尽`
  if (forecast.state === "exhausted") return "已用尽"
  if (forecast.state === "stale") return "上次数据 · 暂无预测"
  if (forecast.state === "refreshing") return "更新中 · 暂无预测"
  if (forecast.state === "resetting") return "等待新周期数据"
  if (forecast.state === "early") return "刚开始 · 暂无法预测"
  if (forecast.remainingAtReset !== undefined) {
    const remaining = forecast.remainingAtReset > 0 && forecast.remainingAtReset < 1
      ? "<1" : Math.round(forecast.remainingAtReset)
    return `重置时预计剩余 ${remaining}%`
  }
  return "暂无预测"
}

export function QuotaMetric({ line, displayMode, resetTimerDisplayMode, timeFormatMode, onResetTimerDisplayModeToggle, now, refreshing, stale, lastUpdatedAt }: {
  line: Extract<MetricLine, { type: "progress" }>
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  now: number
  refreshing?: boolean
  stale?: boolean
  lastUpdatedAt?: number | null
}) {
  const validQuota = Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > 0
  const shownAmount = displayMode === "used" ? line.used : Math.max(0, line.limit - line.used)
  const amount = line.format.kind === "percent" ? `${Math.round(shownAmount)}%`
    : line.format.kind === "dollars" ? `$${formatFixedPrecisionNumber(shownAmount)}`
    : `${formatCountNumber(shownAmount)} ${line.format.suffix}`
  const primaryText = validQuota ? `${displayMode === "left" ? "剩余" : "已用"} ${amount}` : "—"
  const resetsAtMs = line.resetsAt ? Date.parse(line.resetsAt) : Number.NaN
  const forecast = quotaForecast({ used: line.used, limit: line.limit, resetsAtMs, periodDurationMs: line.periodDurationMs, now, stale, refreshing })
  const resetLabel = line.resetsAt ? resetTimerDisplayMode === "absolute"
    ? formatResetAbsoluteLabel(now, line.resetsAt, timeFormatMode) : formatResetRelativeLabel(now, line.resetsAt) : null
  const resetTooltip = line.resetsAt ? formatResetTooltipText({ nowMs: now, resetsAtIso: line.resetsAt, visibleMode: resetTimerDisplayMode, timeFormatMode }) : null
  const limitLabel = line.format.kind === "percent" ? `${line.limit}%`
    : line.format.kind === "dollars" ? `$${formatFixedPrecisionNumber(line.limit)}`
    : `${formatCountNumber(line.limit)} ${line.format.suffix}`
  const paceStatus = forecast.state === "exhausted" ? "behind"
    : forecast.state === "ahead" || forecast.state === "on-track" || forecast.state === "behind" ? forecast.state : null
  const hasPaceContext = Number.isFinite(resetsAtMs) && Number.isFinite(line.periodDurationMs) && line.periodDurationMs! > 0
  const markerValue = hasPaceContext && paceStatus && paceStatus !== "on-track"
    ? (() => {
        const elapsedPercent = clamp01((now - (resetsAtMs - line.periodDurationMs!)) / line.periodDurationMs!) * 100
        return displayMode === "used" ? elapsedPercent : 100 - elapsedPercent
      })()
    : undefined
  const deficit = hasPaceContext && paceStatus && forecast.state !== "exhausted"
    ? calculateDeficit(line.used, line.limit, resetsAtMs, line.periodDurationMs!, now) : null
  const deficitText = deficit !== null ? formatDeficitText(deficit, line.format, displayMode) : null
  const showForecast = line.resetsAt || line.periodDurationMs || stale || refreshing || forecast.state === "exhausted"
  const paceLabel = forecast.state === "exhausted" ? "已达上限" : paceStatus ? getPaceStatusText(paceStatus) : null
  const paceColor = paceStatus === "ahead" ? "bg-green-500" : paceStatus === "on-track" ? "bg-yellow-500" : "bg-red-500"
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
        <span className="text-sm font-medium">{line.label}</span>
        {paceStatus ? (
          <Tooltip>
            <TooltipTrigger render={(props) => <span {...props} data-slot="pace-indicator" data-state={forecast.state}
              aria-label={paceLabel!} className={`inline-block size-2 shrink-0 rounded-full ${paceColor}`} />} />
            <TooltipContent side="top" className="text-xs">{paceLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {validQuota ? <Progress aria-label={`${line.label} ${primaryText}`} value={Math.round(clamp01(shownAmount / line.limit) * 10000) / 100}
        indicatorColor={line.color} markerValue={markerValue} refreshing={refreshing} /> : <div className="h-3 rounded-full bg-muted" />}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>{primaryText}</span>
        {resetLabel ? (
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <span>{resetLabel}</span>
            {onResetTimerDisplayModeToggle ? (
              <Tooltip>
                <TooltipTrigger render={(props) => (
                  <button {...props} type="button" onClick={onResetTimerDisplayModeToggle}
                    aria-label={resetTimerDisplayMode === "relative" ? "切换为具体重置时间" : "切换为重置倒计时"}
                    className="flex size-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-ring">
                    {resetTimerDisplayMode === "relative" ? <CalendarClock aria-hidden className="size-3" /> : <Timer aria-hidden className="size-3" />}
                  </button>
                )} />
                <TooltipContent>{resetTooltip}</TooltipContent>
              </Tooltip>
            ) : resetTooltip ? (
              <Tooltip>
                <TooltipTrigger render={(props) => <Clock3 {...props} role="img" aria-label={resetTooltip} className="size-3 shrink-0" />} />
                <TooltipContent>{resetTooltip}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ) : validQuota ? <span className="ml-auto">{limitLabel} 上限</span> : null}
      </div>
      {!validQuota ? <p className="mt-0.5 text-xs text-muted-foreground">额度暂无数据</p> : null}
      {showForecast ? <div className="mt-0.5 flex flex-wrap justify-between gap-x-2 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        {deficitText ? <span>{deficitText}</span> : null}
        <span className="ml-auto">{forecastLabel(forecast)}</span>
      </div> : null}
      {stale && lastUpdatedAt != null ? <p className="mt-0.5 text-[10px] text-muted-foreground">
        上次更新 <time dateTime={new Date(lastUpdatedAt).toISOString()}>{new Date(lastUpdatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
      </p> : null}
    </div>
  )
}
