import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { UsageSparkline } from "@/components/usage-sparkline"
import { useProviderReports } from "@/hooks/use-provider-reports"
import type { ProviderReportStatus } from "@/lib/provider-reports"

const STATUS_LABELS: Record<ProviderReportStatus, string> = {
  ready: "Ready", partial: "Partial", notSupported: "Not Supported",
  permissionDenied: "Access Denied", rateLimited: "Rate Limited", authExpired: "Sign In Required", error: "Unavailable",
}
const SCOPE_NOTES: Record<string, string> = {
  codex: "当前 ChatGPT 登录及工作区的个人服务端统计，与本地日志估算分别显示。",
  openrouter: "当前管理 Key 可读取的活动；Account Activity 与 Listed Keys Spend 的范围可能不同。",
  ollama: "当前 API Key 的个人模型统计；账号共享额度与余额请查看额度卡片。",
}

export function ServerUsageReports({ providerId, sourceRefreshing = false, connectionId }: { providerId: string; sourceRefreshing?: boolean; connectionId?: string }) {
  const { snapshot, loading, error, load } = useProviderReports(providerId, connectionId)
  const [range, setRange] = useState("7d")
  const scoped = providerId === "ollama" && Boolean(connectionId)
  const reports = snapshot?.reports.filter((report) => !scoped || report.id === range) ?? []
  const lines = snapshot?.lines.filter((line) => !scoped || line.label.startsWith(range.toUpperCase() + " ")) ?? []
  return (
    <section aria-label="Server Reports" className="mt-4 space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Server Reports</h3>
        <Button type="button" size="sm" variant="outline" disabled={loading || sourceRefreshing} onClick={() => void load()}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          {loading ? "Loading…" : snapshot ? "Refresh Reports" : "Load Reports"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {SCOPE_NOTES[providerId]}未报告的日期不按零处理。
      </p>
      {scoped ? <div className="flex gap-1" aria-label="报告范围">{["7d", "30d"].map((value) => <Button key={value} type="button" size="sm" variant={range === value ? "secondary" : "ghost"} aria-pressed={range === value} onClick={() => setRange(value)}>{value === "7d" ? "7 天" : "30 天"}</Button>)}</div> : null}
      {loading ? <p role="status" className="text-xs text-muted-foreground">正在读取服务端报告，额度仍可正常刷新…</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {snapshot ? <>
        <div className="space-y-3">
          {reports.map((report) => <div key={report.id} className="space-y-1 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-medium">{report.label}</h4>
              <Badge variant="outline">{STATUS_LABELS[report.status]}</Badge>
            </div>
            {report.message ? <p className={report.status === "error" ? "text-destructive" : "text-muted-foreground"}>{report.message}</p> : null}
            {report.coverage ? <p className="text-muted-foreground">
              {report.coverage.fromDate} – {report.coverage.toDate} · {report.coverage.timeZone}
              {report.coverage.missingDates.length ? ` · ${report.coverage.missingDates.length} 天未报告` : ""}
            </p> : null}
            {report.retryAt ? <p className="text-muted-foreground">可重试于 {new Date(report.retryAt).toLocaleString()}</p> : null}
          </div>)}
        </div>
        <div className="space-y-2">
          {lines.map((line, index) => line.type === "barChart" ? <UsageSparkline key={`${line.label}-${index}`} {...line} /> : (
            <div key={`${line.label}-${index}`} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 text-muted-foreground">{line.label}</span>
              <span className="max-w-[65%] break-words text-right tabular-nums" style={line.color ? { color: line.color } : undefined}>
                {line.value}{line.subtitle ? <span className="ml-1 text-muted-foreground">{line.subtitle}</span> : null}
              </span>
            </div>
          ))}
        </div>
        {!lines.length && reports.length > 0 && reports.every((report) => report.status === "ready") ? <p className="text-xs text-muted-foreground">所示窗口暂无报告记录。</p> : null}
        <p className="text-xs text-muted-foreground">报告更新于 <time dateTime={snapshot.fetchedAt}>{new Date(snapshot.fetchedAt).toLocaleString()}</time></p>
      </> : null}
    </section>
  )
}
