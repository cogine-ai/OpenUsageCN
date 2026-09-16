import { useEffect, useRef, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { exportCursorHistoryCsv, type CompleteHistory } from "@/lib/cursor-history"
import { historyDateTime, snapshotKey } from "@/lib/cursor-history-summary"

export function CursorHistoryControls({ providerId, accountId, snapshot, refreshing }: {
  providerId: string
  accountId: string
  snapshot: CompleteHistory
  refreshing: boolean
}) {
  const { fromMs, toMs, timeZone } = snapshot.coverage
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <p className="text-xs text-muted-foreground tabular-nums" aria-label="Usage Coverage">
        {historyDateTime(fromMs, timeZone)} – {historyDateTime(toMs, timeZone)}
      </p>
      <CursorHistoryExport key={`${accountId}:${snapshotKey(snapshot)}`} providerId={providerId} accountId={accountId} snapshot={snapshot} available={!refreshing} />
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
      console.error("Failed to export current Cursor usage")
      if (active.current) setError(true)
    } finally {
      if (active.current) setSaving(false)
    }
  }
  return (
    <div className="contents">
      <Tooltip>
        <TooltipTrigger render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={saving ? "Exporting…" : "Export CSV"}
            onClick={() => void save()}
            disabled={!available || saving}
          />
        }>
          <Download className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{saving ? "正在导出…" : "导出 CSV"}</TooltipContent>
      </Tooltip>
      {path ? <p role="status" className="col-span-2 break-all text-xs text-muted-foreground">已保存至 {path}</p> : null}
      {error ? <p role="alert" className="col-span-2 text-xs text-destructive">导出失败，请刷新用量后重试，并检查下载文件夹权限。</p> : null}
    </div>
  )
}
