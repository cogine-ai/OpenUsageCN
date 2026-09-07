import { useEffect, useRef, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { exportCursorHistoryCsv, type CompleteHistory } from "@/lib/cursor-history"
import {
  comparisonUnavailableReason, historyDateTime, historyWindowLabel, percentageChange,
  snapshotKey, snapshotTotals, HISTORY_USD_FORMAT,
} from "@/lib/cursor-history-summary"
import { formatCountNumber } from "@/lib/utils"

export function CursorHistoryControls({
  providerId, accountId, current, selected, recorded, onSelect, error,
}: {
  providerId: string
  accountId: string
  current: CompleteHistory
  selected: CompleteHistory
  recorded: CompleteHistory[]
  onSelect: (key: string) => void
  error: string | null
}) {
  const windows = [current, ...recorded.filter((window) => snapshotKey(window) !== snapshotKey(current))]
  const stored = recorded.some((window) => snapshotKey(window) === snapshotKey(selected))
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
          <span>Recorded Windows</span>
          <select
            aria-label="Recorded Windows"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={snapshotKey(selected)}
            onChange={(event) => onSelect(event.target.value)}
          >
            {windows.map((window, index) => (
              <option key={snapshotKey(window)} value={snapshotKey(window)}>
                {index === 0 ? "Latest · " : "Stored · "}{historyWindowLabel(window)}
              </option>
            ))}
          </select>
        </label>
        <CursorHistoryExport key={`${accountId}:${snapshotKey(selected)}`} providerId={providerId} accountId={accountId} snapshot={selected} available={stored} />
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">最多保留 12 个已记录窗口；选择历史只读取本地记录。</p>
    </div>
  )
}

function CursorHistoryExport({ providerId, accountId, snapshot, available }: {
  providerId: string; accountId: string; snapshot: CompleteHistory; available: boolean
}) {
  const active = useRef(true)
  const [saving, setSaving] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  async function save() {
    setSaving(true)
    setError(false)
    setPath(null)
    try {
      const exported = await exportCursorHistoryCsv(providerId, accountId, snapshot)
      if (active.current) setPath(exported)
    } catch {
      console.error("Failed to export stored Cursor window")
      if (active.current) setError(true)
    } finally {
      if (active.current) setSaving(false)
    }
  }
  return (
    <div className="max-w-full space-y-1">
      <Button variant="outline" size="sm" onClick={() => void save()} disabled={!available || saving}>
        <Download className="size-3" />{saving ? "Exporting…" : "Export CSV"}
      </Button>
      {path ? <p role="status" className="max-w-64 break-all text-xs text-muted-foreground">已保存至 {path}</p> : null}
      {error ? <p role="alert" className="max-w-64 text-xs text-destructive">导出失败，请检查下载文件夹权限后重试。</p> : null}
    </div>
  )
}

export function CursorHistoryComparison({ selected, previous }: {
  selected: CompleteHistory; previous: CompleteHistory | undefined
}) {
  if (!previous) return <p className="text-xs text-muted-foreground">尚无更早的已记录窗口可供对照。</p>
  const reason = comparisonUnavailableReason(selected, previous)
  const currentTotals = snapshotTotals(selected)
  const previousTotals = snapshotTotals(previous)
  const meteredComparable = !reason && selected.totals.meteredCoverage === "complete"
    && previous.totals.meteredCoverage === "complete"
    && selected.totals.meteredChargedUsd !== null && previous.totals.meteredChargedUsd !== null
  const listComparable = !reason && !currentTotals.partialListPrice && !previousTotals.partialListPrice
    && currentTotals.knownListPriceBuckets > 0 && previousTotals.knownListPriceBuckets > 0
  const rows = [
    { label: "Tokens", current: currentTotals.tokens, previous: previousTotals.tokens, comparable: !reason, money: false, currentPartial: false, previousPartial: false },
    { label: "List-Price Equivalent", current: currentTotals.knownListPriceBuckets ? currentTotals.listPrice : null,
      previous: previousTotals.knownListPriceBuckets ? previousTotals.listPrice : null, comparable: listComparable, money: true,
      currentPartial: currentTotals.partialListPrice, previousPartial: previousTotals.partialListPrice },
    { label: "Metered Usage", current: selected.totals.meteredChargedUsd, previous: previous.totals.meteredChargedUsd, comparable: meteredComparable, money: true,
      currentPartial: selected.totals.meteredCoverage !== "complete", previousPartial: previous.totals.meteredCoverage !== "complete" },
  ]
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <h4 className="text-xs font-medium">Previous Recorded Window</h4>
      <p className="text-xs text-muted-foreground">
        上一窗口：{historyDateTime(previous.coverage.fromMs, previous.coverage.timeZone, true)} – {historyDateTime(previous.coverage.toMs, previous.coverage.timeZone, true)} · {previous.coverage.timeZone}
      </p>
      <div
        role="region"
        aria-label="Recorded Window Comparison"
        tabIndex={0}
        className="overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full min-w-96 text-xs [&_th]:px-3 [&_th]:py-1.5 [&_td]:px-3 [&_td]:py-1.5 [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0 [&_th:not(:first-child)]:whitespace-nowrap [&_td:not(:first-child)]:whitespace-nowrap">
          <thead className="text-muted-foreground">
            <tr><th className="py-1 text-left font-normal">Metric</th><th className="text-right font-normal">Selected</th><th className="text-right font-normal">Previous</th><th className="text-right font-normal">Change</th></tr>
          </thead>
          <tbody>{rows.map((row) => {
            const format = (value: number | null) => value === null ? "Unavailable" : row.money ? HISTORY_USD_FORMAT.format(value) : formatCountNumber(value)
            const change = row.comparable && row.current !== null && row.previous !== null ? percentageChange(row.current, row.previous) : null
            return <tr key={row.label}>
              <td className="py-1">{row.label}</td><td className="text-right tabular-nums">{format(row.current)}{row.currentPartial ? " · Partial" : ""}</td><td className="text-right tabular-nums">{format(row.previous)}{row.previousPartial ? " · Partial" : ""}</td>
              <td className="text-right tabular-nums">{change === null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
      {reason ? <p className="text-xs text-muted-foreground"><span className="font-medium">Cannot Compare</span> · {reason}仅并列展示，不计算变化百分比。</p>
        : <p className="text-xs text-muted-foreground">仅对相同覆盖范围计算变化；金额资料不完整或上一值为零时不计算百分比。</p>}
    </div>
  )
}
