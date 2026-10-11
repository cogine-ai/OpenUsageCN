import { Fragment, useMemo } from "react"
import { ExternalLink, Hourglass, RefreshCw, Wrench } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SkeletonLines } from "@/components/skeleton-lines"
import { MetricLineRenderer } from "@/components/provider-metric"
import { PluginError } from "@/components/plugin-error"
import { ProviderStatusNotice } from "@/components/provider-status-notice"
import { useNowTicker } from "@/hooks/use-now-ticker"
import { useProviderStatus } from "@/hooks/use-provider-status"
import { REFRESH_COOLDOWN_MS, type DisplayMode, type ResetTimerDisplayMode, type TimeFormatMode } from "@/lib/settings"
import type { ManifestLine, MetricLine, PluginLink, PluginStatusPage } from "@/lib/plugin-types"
import { groupLinesByType } from "@/lib/group-lines-by-type"

import type { PluginMeta } from "@/lib/plugin-types"
import { getPluginRecovery, type PluginRecovery } from "@/lib/plugin-recovery"

interface ProviderCardProps {
  capabilities?: Pick<PluginMeta, "config" | "accountSupport">
  onRecovery?: (recovery: PluginRecovery) => void
  providerId?: string
  name: string
  plan?: string
  links?: PluginLink[]
  statusPage?: PluginStatusPage
  showSeparator?: boolean
  loading?: boolean
  error?: string | null
  lines?: MetricLine[]
  skeletonLines?: ManifestLine[]
  lastManualRefreshAt?: number | null
  lastUpdatedAt?: number | null
  onRetry?: () => void
  scopeFilter?: "overview" | "all"
  displayMode: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

function formatRelativeTime(diffMs: number): string {
  const seconds = Math.floor(Math.max(0, diffMs) / 1000)
  if (seconds < 60) return "刚刚"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

export function ProviderCard({
  capabilities,
  onRecovery,
  providerId,
  name,
  plan,
  links = [],
  statusPage,
  showSeparator = true,
  loading = false,
  error = null,
  lines = [],
  skeletonLines = [],
  lastManualRefreshAt,
  lastUpdatedAt,
  onRetry,
  scopeFilter = "all",
  displayMode,
  resetTimerDisplayMode = "relative",
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: ProviderCardProps) {
  const recovery = error ? getPluginRecovery(error, providerId, capabilities) : null
  const needsRepair = recovery && recovery.action !== "retry" && onRecovery
  const providerStatus = useProviderStatus(providerId ?? "", providerId ? statusPage : undefined)
  const cooldownRemainingMs = useMemo(() => {
    if (error || !lastManualRefreshAt) return 0
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastManualRefreshAt)
    return remaining > 0 ? remaining : 0
  }, [error, lastManualRefreshAt])

  // Filter lines based on scope - match by label since runtime lines can differ from manifest
  const overviewLabels = new Set(
    skeletonLines
      .filter(line => line.scope === "overview")
      .map(line => line.label)
  )
  const filteredSkeletonLines = scopeFilter === "all"
    ? skeletonLines
    : skeletonLines.filter(line => line.scope === "overview")
  const filteredLines = scopeFilter === "all"
    ? lines
    : lines.filter(line => overviewLabels.has(line.label))

  const hasResetCountdown = filteredLines.some(
    (line) => line.type === "progress" && Boolean(line.resetsAt)
  )

  // "has ever loaded" — true if either we have a prior success timestamp,
  // or the parent is passing lines directly (tests + legacy state paths).
  const hasStaleData = lastUpdatedAt != null || filteredLines.length > 0
  const isRefreshingWithData = loading && hasStaleData

  const tickerIntervalMs = cooldownRemainingMs > 0 ? 1000 : 30_000

  const now = useNowTicker({
    enabled: cooldownRemainingMs > 0 || hasResetCountdown,
    intervalMs: tickerIntervalMs,
    stopAfterMs: cooldownRemainingMs > 0 && !hasResetCountdown ? cooldownRemainingMs : null,
  })

  const inCooldown = !error && lastManualRefreshAt
    ? now - lastManualRefreshAt < REFRESH_COOLDOWN_MS
    : false

  const visibleLinks = useMemo(
    () =>
      links
        .map((link) => ({
          label: link.label.trim(),
          url: link.url.trim(),
        }))
        .filter(
          (link) =>
            link.label.length > 0 &&
            link.url.length > 0 &&
            (link.url.startsWith("https://") || link.url.startsWith("http://"))
        ),
    [links]
  )

  // Format remaining cooldown time as "Xm Ys"
  const formatRemainingTime = () => {
    if (!lastManualRefreshAt) return ""
    const remainingMs = REFRESH_COOLDOWN_MS - (now - lastManualRefreshAt)
    if (remainingMs <= 0) return ""
    const totalSeconds = Math.ceil(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
      return seconds > 0 ? `${minutes} 分 ${seconds} 秒后可刷新` : `${minutes} 分钟后可刷新`
    }
    return `${seconds} 秒后可刷新`
  }

  return (
    <div>
      <div className="py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="relative flex items-center">
            <h2 className="text-lg font-semibold" style={{ transform: "translateZ(0)" }}>{name}</h2>
            {onRetry && (
              loading ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-1 pointer-events-none opacity-50"
                  style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                  tabIndex={-1}
                >
                  <RefreshCw className="h-3 w-3 animate-spin" />
                </Button>
              ) : inCooldown ? (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <span {...props} className={props.className}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="pointer-events-none opacity-50"
                          style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                          tabIndex={-1}
                        >
                          <Hourglass className="h-3 w-3" />
                        </Button>
                      </span>
                    )}
                  />
                  <TooltipContent side="top">
                    {formatRemainingTime()}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={needsRepair ? recovery.actionLabel : "刷新"}
                        onClick={(e) => {
                          e.currentTarget.blur()
                          if (needsRepair) onRecovery(recovery)
                          else onRetry()
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                      >
                        {needsRepair ? <Wrench className="size-3" /> : <RefreshCw className="size-3" />}
                      </Button>
                    )}
                  />
                  {lastUpdatedAt != null && (
                    <TooltipContent side="top">
                      {formatRelativeTime(Date.now() - lastUpdatedAt)}更新
                    </TooltipContent>
                  )}
                </Tooltip>
              )
            )}
          </div>
          {plan && (
            <Badge
              variant="outline"
              className="truncate min-w-0 max-w-[50%]"
              title={plan}
            >
              {plan}
            </Badge>
          )}
        </div>
        {visibleLinks.length > 0 && (
          <div className="mb-2 -mt-0.5 flex flex-wrap gap-1.5">
            {visibleLinks.map((link) => (
              <Button
                key={`${link.label}-${link.url}`}
                variant="outline"
                size="xs"
                className="h-6 max-w-full text-[11px]"
                onClick={() => {
                  openUrl(link.url).catch(console.error)
                }}
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink className="size-3 opacity-70" />
              </Button>
            ))}
          </div>
        )}
        {error && (
          <PluginError message={error} providerId={providerId} capabilities={capabilities} onRecovery={onRecovery} onRetry={onRetry} retrying={loading} hasStaleData={hasStaleData} lastUpdatedAt={lastUpdatedAt} />
        )}

        {statusPage && (
          <ProviderStatusNotice status={providerStatus} statusUrl={statusPage.url} />
        )}

        {loading && !hasStaleData && !error && (
          <SkeletonLines lines={filteredSkeletonLines} />
        )}

        {hasStaleData && (
          <div className="space-y-4">
            {groupLinesByType(filteredLines).map((group, gi) =>
              group.kind === "text" ? (
                <div key={gi} className="space-y-1">
                  {group.lines.map((line, li) => (
                    <MetricLineRenderer
                      key={`${line.label}-${gi}-${li}`}
                      line={line}
                      displayMode={displayMode}
                      resetTimerDisplayMode={resetTimerDisplayMode}
                      timeFormatMode={timeFormatMode}
                      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                      now={now}
                      refreshing={isRefreshingWithData}
                      stale={Boolean(error)}
                      lastUpdatedAt={lastUpdatedAt}
                    />
                  ))}
                </div>
              ) : (
                <Fragment key={gi}>
                  {group.lines.map((line, li) => (
                    <MetricLineRenderer
                      key={`${line.label}-${gi}-${li}`}
                      line={line}
                      displayMode={displayMode}
                      resetTimerDisplayMode={resetTimerDisplayMode}
                      timeFormatMode={timeFormatMode}
                      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                      now={now}
                      refreshing={isRefreshingWithData}
                      stale={Boolean(error)}
                      lastUpdatedAt={lastUpdatedAt}
                    />
                  ))}
                </Fragment>
              )
            )}
          </div>
        )}

      </div>
      {showSeparator && <Separator />}
    </div>
  )
}
