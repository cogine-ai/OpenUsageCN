import { AlertCircle, ArrowRight, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getPluginRecovery, type PluginRecovery } from "@/lib/plugin-recovery"
import type { PluginMeta } from "@/lib/plugin-types"

type Props = {
  message: string
  providerId?: string
  capabilities?: Pick<PluginMeta, "config" | "accountSupport">
  onRecovery?: (recovery: PluginRecovery) => void
  onRetry?: () => void
  retrying?: boolean
  hasStaleData?: boolean
  lastUpdatedAt?: number | null
}

export function PluginError({ message, providerId, capabilities, onRecovery, onRetry, retrying = false, hasStaleData = false, lastUpdatedAt }: Props) {
  const recovery = getPluginRecovery(message, providerId, capabilities)
  const directs = recovery.action !== "retry" && onRecovery
  return <div role="alert" className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
    <div className="flex items-center gap-2 text-sm font-medium"><AlertCircle className="size-4 shrink-0 text-amber-600" />{recovery.title}</div>
    {(directs || onRetry) && <Button variant={directs ? "default" : "outline"} size="sm" className="mt-3 w-full" disabled={retrying} onClick={() => directs ? onRecovery(recovery) : onRetry?.()}>{directs ? <ArrowRight className="size-4" /> : <RefreshCw className={retrying ? "size-4 animate-spin" : "size-4"} />}{retrying ? "正在检查" : directs ? recovery.actionLabel : "重试"}</Button>}
    {hasStaleData && <p className="mt-2 text-xs text-muted-foreground">上次数据{lastUpdatedAt ? ` · ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</p>}
    <details className="mt-2 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">诊断详情</summary><p className="mt-2 select-text leading-relaxed">{recovery.advice}</p><pre className="mt-2 select-text whitespace-pre-wrap break-all font-sans leading-relaxed">{recovery.diagnostic}</pre></details>
  </div>
}
