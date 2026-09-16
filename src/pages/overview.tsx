import { ProviderCard } from "@/components/provider-card"
import type { MetricLine, ManifestLine, PluginDisplayState } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

function overviewLines<T extends MetricLine | ManifestLine>(
  providerId: string, lines: T[], available: (MetricLine | ManifestLine)[] = lines
): T[] {
  if (providerId !== "cursor") return lines
  const hasMonthlyPools = ["Cursor Models", "Other Models"].every((label) =>
    available.some((line) => line.type === "progress" && line.label === label)
  )
  const hasDollarTotal = available.some((line) =>
    line.type === "progress" && line.label === "Total usage" &&
    "format" in line && line.format.kind === "dollars"
  )
  return hasMonthlyPools && !hasDollarTotal ? lines.filter((line) => line.label !== "Total usage") : lines
}

interface OverviewPageProps {
  plugins: PluginDisplayState[]
  onRetryPlugin?: (pluginId: string) => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

export function OverviewPage({
  plugins,
  onRetryPlugin,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: OverviewPageProps) {
  if (plugins.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        尚未启用服务商
      </div>
    )
  }

  return (
    <div>
      {plugins.map((plugin, index) => (
        <ProviderCard
          key={plugin.meta.id}
          providerId={plugin.meta.id}
          name={plugin.meta.name}
          plan={plugin.data?.plan}
          showSeparator={index < plugins.length - 1}
          loading={plugin.loading}
          error={plugin.error}
          lines={overviewLines(plugin.meta.id, plugin.data?.lines ?? [])}
          skeletonLines={overviewLines(plugin.meta.id, plugin.meta.lines, plugin.data?.lines ?? plugin.meta.lines)}
          statusPage={plugin.meta.statusPage}
          lastManualRefreshAt={plugin.lastManualRefreshAt}
          lastUpdatedAt={plugin.lastUpdatedAt}
          onRetry={onRetryPlugin ? () => onRetryPlugin(plugin.meta.id) : undefined}
          scopeFilter="overview"
          displayMode={displayMode}
          resetTimerDisplayMode={resetTimerDisplayMode}
          timeFormatMode={timeFormatMode}
          onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
        />
      ))}
    </div>
  )
}
