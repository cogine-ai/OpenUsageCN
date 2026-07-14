import { useCallback, useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"

type CliInstallStatus = {
  available: boolean
  state: "notInstalled" | "installed" | "conflict" | "unavailable"
  destination: string
  message: string | null
}

export function CliSection() {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    try {
      setStatus(await invoke<CliInstallStatus>("get_cli_install_status"))
    } catch (loadError) {
      console.error("Failed to load CLI install status:", loadError)
      setError("无法读取命令行工具状态。")
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const update = async (installed: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await invoke<CliInstallStatus>("set_cli_installed", { installed }))
    } catch (updateError) {
      console.error("Failed to update CLI installation:", updateError)
      setError(typeof updateError === "string" ? updateError : "无法更新命令行工具。")
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const installed = status?.state === "installed"
  const unavailable = !status?.available || status.state === "conflict"

  return (
    <section>
      <div className="mb-2 flex items-start gap-2">
        <Terminal className="mt-0.5 size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold leading-none">命令行</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            安装全局 openusage 命令，供脚本和本地智能体读取额度
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant={installed ? "outline" : "default"}
        size="sm"
        className="w-full"
        disabled={busy || unavailable}
        onClick={() => void update(!installed)}
      >
        {busy ? "处理中…" : installed ? "移除命令" : "安装命令"}
      </Button>
      <p className="mt-1.5 break-all text-xs text-muted-foreground">
        {status?.message ?? status?.destination ?? "/usr/local/bin/openusage"}
      </p>
      {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
