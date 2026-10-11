import { useAppUiStore } from "@/stores/app-ui-store"
import { ProviderAccountControls } from "@/components/provider-account-controls"
import { ProviderCard } from "@/components/provider-card"
import { LocalUsageHistory } from "@/components/local-usage-history"
import type { PluginDisplayState } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

interface ProviderDetailPageProps {
  plugin: PluginDisplayState | null
  onRetry?: () => void
  onAccountChangeRefresh?: () => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

/** Combines provider usage and account controls with explicit connection repair routes. */
export function ProviderDetailPage({
  plugin,
  onRetry,
  onAccountChangeRefresh,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: ProviderDetailPageProps) {
  const openConnection = useAppUiStore((state) => state.openConnection)
  if (!plugin) {
    return (
      <div className="text-center text-muted-foreground py-8">
        未找到服务商
      </div>
    )
  }

  return (
    <>
      <ProviderCard
        capabilities={plugin.meta}
        onRecovery={(recovery) => openConnection(plugin.meta.id, recovery.action === "accounts" ? "accounts" : recovery.action === "config" ? "config" : "local", recovery.focusField)}
        providerId={plugin.meta.id}
        name={plugin.meta.name}
        plan={plugin.data?.plan}
        links={plugin.meta.links}
        showSeparator={false}
        loading={plugin.loading}
        error={plugin.error}
        lines={(plugin.data?.lines ?? []).map((line) =>
          plugin.meta.id === "cursor" && line.label === "Total usage"
            ? { ...line, label: "Monthly Total" }
            : line
        )}
        skeletonLines={plugin.meta.lines.map((line) =>
          plugin.meta.id === "cursor" && line.label === "Total usage"
            ? { ...line, label: "Monthly Total" }
            : line
        )}
        statusPage={plugin.meta.statusPage}
        lastManualRefreshAt={plugin.lastManualRefreshAt}
        lastUpdatedAt={plugin.lastUpdatedAt}
        onRetry={onRetry}
        scopeFilter="all"
        displayMode={displayMode}
        resetTimerDisplayMode={resetTimerDisplayMode}
        timeFormatMode={timeFormatMode}
        onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
      />
      {plugin.meta.id === "codex" ? <LocalUsageHistory providerId="codex" /> : null}
      {plugin.meta.accountSupport ? (
        <ProviderAccountControls
          key={plugin.meta.id}
          providerId={plugin.meta.id}
          browserBinding={plugin.meta.accountSupport.browserBinding}
          modelHistory={plugin.meta.accountSupport.modelHistory}
          onOpenConnections={() => openConnection(plugin.meta.id, "accounts")}
          onOpenLocalLogin={() => openConnection(plugin.meta.id, "local")}
          onAccountChangeRefresh={onAccountChangeRefresh}
        />
      ) : null}
    </>
  )
}
