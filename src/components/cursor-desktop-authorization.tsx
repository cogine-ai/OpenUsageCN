import { useState } from "react"
import { Button } from "@/components/ui/button"

export function CursorDesktopAuthorization({ busy, pending, onPendingChange, authorize }: {
  busy: boolean
  pending: boolean
  onPendingChange: (pending: boolean) => void
  authorize: () => Promise<void>
}) {
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  const refresh = async () => {
    onPendingChange(true)
    setResult(null)
    try {
      await authorize()
      setResult({ success: true, message: "Cursor 桌面用量已刷新。" })
    } catch (cause) {
      setResult({
        success: false,
        message: cause instanceof Error ? cause.message : "无法授权 Cursor 桌面连接，请重试。",
      })
    } finally {
      onPendingChange(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Cursor 桌面连接</p>
      <p className="text-xs text-muted-foreground">在 macOS 弹窗中允许访问后，将切换到桌面账号并刷新用量。</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
        {pending ? "正在授权并刷新…" : "授权并刷新"}
      </Button>
      {result ? (
        <p role={result.success ? "status" : "alert"}
          className={result.success ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {result.message}
        </p>
      ) : null}
    </div>
  )
}
