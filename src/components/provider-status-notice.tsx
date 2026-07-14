import { AlertTriangle, ExternalLink } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { ProviderStatus } from "@/lib/plugin-types"

type ProviderStatusNoticeProps = {
  status: ProviderStatus | null
  statusUrl: string
}

export function ProviderStatusNotice({ status, statusUrl }: ProviderStatusNoticeProps) {
  if (!status || status.level === "operational") return null

  const isOutage = status.level === "outage"
  return (
    <Alert
      variant={isOutage ? "destructive" : "default"}
      title={status.description}
      className={
        `mb-2 flex items-start gap-2 p-3 [&>svg]:static [&>svg]:mt-0.5 ` +
        `[&>svg]:size-4 [&>svg~*]:pl-0 [&>svg+div]:translate-y-0 ` +
        (isOutage
          ? ""
          : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-600")
      }
    >
      <AlertTriangle />
      <div className="min-w-0 flex-1">
        <AlertTitle>{isOutage ? "服务商服务中断" : "服务商服务异常"}</AlertTitle>
        <AlertDescription className="text-xs">
          {isOutage
            ? "服务商当前发生服务中断，数据刷新可能失败。"
            : "服务商当前部分功能异常，数据刷新可能受影响。"}
        </AlertDescription>
        <Button
          variant="link"
          size="xs"
          className="mt-1 h-auto p-0 text-current"
          onClick={() => {
            openUrl(statusUrl).catch(console.error)
          }}
        >
          查看服务状态
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </Alert>
  )
}
