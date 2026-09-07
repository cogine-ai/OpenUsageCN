import { AlertCircle, RefreshCw } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getPluginRecovery } from "@/lib/plugin-recovery"

type PluginErrorProps = {
  message: string
  providerId?: string
  onRetry?: () => void
  retrying?: boolean
  hasStaleData?: boolean
}

function formatMessage(message: string) {
  const parts = message.split(/`([^`]+)`/)
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <code
        key={`code-${index}`}
        className="rounded bg-muted px-1 font-mono text-[0.75rem] leading-tight"
      >
        {part}
      </code>
    ) : (
      part
    )
  )
}

export function PluginError({ message, providerId, onRetry, retrying = false, hasStaleData = false }: PluginErrorProps) {
  const recovery = getPluginRecovery(message, providerId)
  return (
    <Alert
      variant="destructive"
      className="mb-3 flex items-start gap-2 p-3 [&>svg]:static [&>svg]:translate-y-0 [&>svg~*]:pl-0 [&>svg+div]:translate-y-0"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <AlertDescription className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <AlertTitle className="mb-1 text-sm leading-5">{recovery.title}</AlertTitle>
          {onRetry && (
            <Button variant="outline" size="xs" disabled={retrying} onClick={onRetry}>
              <RefreshCw className={retrying ? "size-3 animate-spin" : "size-3"} />
              {retrying ? "正在重试" : "重试"}
            </Button>
          )}
        </div>
        <p className="select-text text-xs leading-relaxed">{formatMessage(recovery.advice)}</p>
        {hasStaleData && <p className="mt-1 text-xs text-muted-foreground">当前显示上次成功的数据。</p>}
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none">诊断详情</summary>
          <div className="mt-1 select-text whitespace-pre-wrap break-all leading-relaxed">{formatMessage(recovery.diagnostic)}</div>
        </details>
      </AlertDescription>
    </Alert>
  )
}
