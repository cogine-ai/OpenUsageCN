import { useEffect, useState } from "react"
import {
  fetchLocalHttpApiHealth,
  getLocalHttpApiStatus,
  LOCAL_HTTP_API_BASE_URL,
  type LocalHttpApiHealth,
  type LocalHttpApiServiceStatus,
} from "@/lib/local-http-api"

const READINESS_REFRESH_DELAY_MS = 2_000

function serviceStatusText(status: LocalHttpApiServiceStatus | null): string {
  if (!status) return "读取中"
  if (status.state === "starting") return "启动中"
  if (status.state === "running") return "运行中"
  return "端口不可用"
}

function dataStatusText(
  status: LocalHttpApiServiceStatus | null,
  health: LocalHttpApiHealth | null,
  healthError: string | null
): string {
  if (!status) return "读取中"
  if (status.state === "starting") return "等待服务启动"
  if (status.state === "bind_failed") return "服务未运行"
  if (healthError) return "无法读取健康检查"
  if (!health) return "读取中"
  if (!health.cache.ready) return "等待首次刷新"
  return `已缓存 ${health.providers.cached} 个服务商`
}

export function LocalHttpApiSection() {
  const [serviceStatus, setServiceStatus] = useState<LocalHttpApiServiceStatus | null>(null)
  const [health, setHealth] = useState<LocalHttpApiHealth | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let refreshTimer: ReturnType<typeof window.setTimeout> | null = null

    function scheduleRefresh() {
      if (cancelled) return
      refreshTimer = window.setTimeout(readStatus, READINESS_REFRESH_DELAY_MS)
    }

    function readStatus() {
      getLocalHttpApiStatus()
        .then((status) => {
          if (cancelled) return
          setServiceStatus(status)
          setStatusError(null)

          if (status.state === "starting") {
            scheduleRefresh()
            return
          }

          if (status.state !== "running") return

          fetchLocalHttpApiHealth()
            .then((nextHealth) => {
              if (cancelled) return
              setHealth(nextHealth)
              setHealthError(null)
              if (!nextHealth.cache.ready) scheduleRefresh()
            })
            .catch((error) => {
              if (cancelled) return
              console.error("Failed to read local HTTP API health:", error)
              setHealthError("无法读取健康检查")
              scheduleRefresh()
            })
        })
        .catch((error) => {
          if (cancelled) return
          console.error("Failed to read local HTTP API status:", error)
          setStatusError("无法读取服务状态")
        })
    }

    readStatus()

    return () => {
      cancelled = true
      if (refreshTimer) window.clearTimeout(refreshTimer)
    }
  }, [])

  return (
    <section>
      <h3 className="text-lg font-semibold mb-0">本地 API</h3>
      <p className="text-sm text-muted-foreground mb-2">
        本机工具可读取同一份用量数据
      </p>
      <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">服务</span>
          <span className="font-medium">{serviceStatusText(serviceStatus)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">数据</span>
          <span className="font-medium">{dataStatusText(serviceStatus, health, healthError)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">地址</span>
          <code className="truncate rounded bg-background px-1.5 py-0.5 text-xs">
            {LOCAL_HTTP_API_BASE_URL}
          </code>
        </div>
        {health?.cache.lastSuccessfulFetchAt ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">最近成功</span>
            <span className="truncate text-xs text-muted-foreground">
              {health.cache.lastSuccessfulFetchAt}
            </span>
          </div>
        ) : null}
        {serviceStatus?.state === "bind_failed" ? (
          <p className="break-words text-xs text-destructive">{serviceStatus.error}</p>
        ) : null}
        {statusError ? <p className="text-xs text-destructive">{statusError}</p> : null}
        {!statusError && healthError ? (
          <p className="text-xs text-destructive">{healthError}</p>
        ) : null}
      </div>
    </section>
  )
}
