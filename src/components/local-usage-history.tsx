import { Activity, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { UsageSparkline } from "@/components/usage-sparkline"
import { usePlatformCapabilities } from "@/hooks/app/use-platform-capabilities"
import { useLocalHistory } from "@/hooks/use-local-history"

type LocalUsageHistoryProps = {
  providerId: string
  accountId?: string | null
  disabled?: boolean
}

export function LocalUsageHistory({ providerId, accountId = null, disabled = false }: LocalUsageHistoryProps) {
  const capabilities = usePlatformCapabilities()
  const { snapshot, loading, error, load } = useLocalHistory(providerId, accountId)
  if (!capabilities || capabilities.platform === "windows") return null

  return (
    <section className="mt-4 space-y-3 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold">
          <Activity className="size-4 shrink-0 text-muted-foreground" />
          Local History
        </h3>
        <Button type="button" size="sm" variant="outline" disabled={disabled || loading} onClick={() => { void load() }}>
          <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
          {loading ? "Loading…" : snapshot ? "Refresh Local History" : "Load Local History"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        本地日志按 API 价格估算，可能包含多个会话；不代表账号账单。
      </p>

      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {!snapshot && !loading && !error ? (
        <p className="text-xs text-muted-foreground">按需读取最近 31 个日历日的本地用量，独立于额度刷新。</p>
      ) : null}
      {loading ? <p role="status" className="text-xs text-muted-foreground">正在读取本地历史，额度仍可正常刷新…</p> : null}

      {snapshot ? (
        <>
          <div className="space-y-2">
            {snapshot.lines.map((line, index) => line.type === "barChart" ? (
              <UsageSparkline key={`${line.label}-${index}`} {...line} />
            ) : (
              <div key={`${line.label}-${index}`} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 text-muted-foreground">{line.label}</span>
                <span className="text-right tabular-nums" style={line.color ? { color: line.color } : undefined}>
                  {line.value}{line.subtitle ? <span className="ml-1 text-muted-foreground">{line.subtitle}</span> : null}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            历史更新于 <time dateTime={snapshot.fetchedAt}>{new Date(snapshot.fetchedAt).toLocaleString()}</time>
          </p>
        </>
      ) : null}
    </section>
  )
}
