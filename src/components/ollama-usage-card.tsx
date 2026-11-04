import { ChevronRight, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { MetricLineRenderer } from "@/components/provider-metric"
import { useNowTicker } from "@/hooks/use-now-ticker"
import type { PluginOutput } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

export type OllamaDisplayPreferences = {
  displayMode?: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}
export type OllamaUsageData = {
  snapshot?: PluginOutput
  lastUpdatedAt?: string
  error?: { code: string; message: string }
}

export function OllamaPrimaryBadge() {
  return (
    <Badge variant="secondary" className="gap-1" title="用于菜单栏和本地 API">
      <Star className="size-3" />
      主账号
    </Badge>
  )
}

/** One connection's complete quota stays together; quiet tokens keep account figures in focus. */
export function OllamaQuota({
  snapshot,
  lastUpdatedAt,
  error,
  refreshing = false,
  displayMode = "used",
  resetTimerDisplayMode = "relative",
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: OllamaUsageData & OllamaDisplayPreferences & { refreshing?: boolean }) {
  const now = useNowTicker({
    enabled: Boolean(snapshot?.lines.some((line) => line.type === "progress" && line.resetsAt)),
    intervalMs: 30_000,
  })
  return (
    <>
      {error ? (
        <div role="alert" className="space-y-1 text-xs text-destructive">
          <p>{error.message}</p>
          {snapshot ? (
            <p className="text-muted-foreground">本次未更新，下方保留上次成功读取的数据。</p>
          ) : null}
        </div>
      ) : null}
      {snapshot ? (
        <section aria-label="账户额度" className="space-y-3">
          {snapshot.lines.map((line, index) => (
            <MetricLineRenderer
              key={`${line.label}-${index}`}
              line={line}
              displayMode={displayMode}
              resetTimerDisplayMode={resetTimerDisplayMode}
              timeFormatMode={timeFormatMode}
              onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
              now={now}
              refreshing={refreshing}
              stale={Boolean(error)}
              lastUpdatedAt={lastUpdatedAt ? Date.parse(lastUpdatedAt) : null}
            />
          ))}
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">尚未读取到额度，请刷新此账号。</p>
      )}
      {lastUpdatedAt ? (
        <p className="text-xs text-muted-foreground">
          额度更新于{" "}
          <time dateTime={lastUpdatedAt}>{new Date(lastUpdatedAt).toLocaleString()}</time>
        </p>
      ) : null}
    </>
  )
}

/** Identity leads, quota follows; navigation is outside metric controls to avoid nested buttons. */
export function OllamaUsageCard({
  label,
  identity,
  plan,
  primary,
  onSelect,
  ...props
}: OllamaUsageData &
  OllamaDisplayPreferences & {
    label: string
    identity: string
    plan?: string
    primary: boolean
    refreshing?: boolean
    onSelect: () => void
  }) {
  return (
    <article aria-label={`${label}用量`} className="space-y-3 rounded-lg border p-3">
      <button
        type="button"
        aria-label={`查看${label}用量`}
        onClick={onSelect}
        className="flex min-h-10 w-full items-start justify-between gap-2 rounded-sm text-left focus-visible:outline-ring"
      >
        <span className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all text-sm font-semibold">{label}</span>
            {primary ? <OllamaPrimaryBadge /> : null}
          </span>
          <span className="block break-all text-xs text-muted-foreground">{identity}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {plan ? <Badge variant="outline">{plan}</Badge> : null}
          <ChevronRight className="size-4 text-muted-foreground" />
        </span>
      </button>
      <OllamaQuota {...props} />
    </article>
  )
}
