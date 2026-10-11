import { useCallback, useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { Bell, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { PaceNotificationPreview } from "@/components/pace-notification-preview"
import type { PaceNotificationSettings } from "@/lib/settings"

type PermissionState = "default" | "granted" | "denied" | "unavailable"

type PaceNotificationSettingsProps = {
  value: PaceNotificationSettings
  onChange: (value: PaceNotificationSettings) => Promise<void>
}

const rows: Array<{
  key: keyof PaceNotificationSettings
  label: string
}> = [
  { key: "almostOut", label: "即将用尽" },
  { key: "closeToLimit", label: "接近上限" },
  { key: "runningOut", label: "预计提前用尽" },
]

export function PaceNotificationSettingsSection({
  value,
  onChange,
}: PaceNotificationSettingsProps) {
  const [permission, setPermission] = useState<PermissionState>("unavailable")
  const [error, setError] = useState<string | null>(null)

  const refreshPermission = useCallback(async () => {
    if (!isTauri()) return
    try {
      setError(null)
      setPermission(await invoke<PermissionState>("get_notification_permission"))
    } catch (error) {
      console.error("Failed to load notification permission:", error)
      setPermission("unavailable")
      setError("无法读取系统通知权限。")
    }
  }, [])

  useEffect(() => {
    void refreshPermission()
    window.addEventListener("focus", refreshPermission)
    return () => window.removeEventListener("focus", refreshPermission)
  }, [refreshPermission])

  const requestPermission = async () => {
    try {
      setError(null)
      setPermission(await invoke<PermissionState>("request_notification_permission"))
    } catch (error) {
      console.error("Failed to request notification permission:", error)
      setError("无法请求系统通知权限。")
    }
  }

  const handleToggle = async (key: keyof PaceNotificationSettings, checked: boolean) => {
    const next = { ...value, [key]: checked }
    const isFirstEnable = !Object.values(value).some(Boolean) && Object.values(next).some(Boolean)
    try {
      setError(null)
      await onChange(next)
      if (isFirstEnable && isTauri()) await requestPermission()
    } catch (error) {
      console.error("Failed to save pace notification settings:", error)
      setError("无法保存额度通知设置。")
    }
  }

  const openSystemSettings = async () => {
    try {
      setError(null)
      await invoke("open_notification_settings")
    } catch (error) {
      console.error("Failed to open notification settings:", error)
      setError("无法打开系统通知设置。")
    }
  }

  const anyEnabled = Object.values(value).some(Boolean)

  return (
    <section>
      <div className="mb-2 flex items-start gap-2">
        <Bell className="mt-0.5 size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold leading-none">额度通知</h3>
            {anyEnabled && permission !== "granted" ? (
              <TriangleAlert className="size-4 text-amber-500" aria-label="系统通知权限未开启" />
            ) : null}
          </div>
        </div>
      </div>
      <div className="space-y-3 rounded-lg bg-muted/50 p-2">
        {(["当前额度", "使用预测"] as const).map((group) => (
          <fieldset key={group} className="min-w-0 space-y-1.5">
            <legend className="mb-1 text-[10px] font-medium text-muted-foreground">{group}</legend>
            {rows.filter((row) => group === "当前额度" ? row.key === "almostOut" : row.key !== "almostOut").map((row) => (
              <label key={row.key} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md bg-background p-2 text-sm select-none hover:bg-accent/50">
                <Checkbox aria-label={row.label} checked={value[row.key]}
                  onCheckedChange={(checked) => void handleToggle(row.key, checked === true)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-foreground">{row.label}</span>
                  <PaceNotificationPreview kind={row.key} />
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {anyEnabled && permission === "default" ? (
        <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={() => void requestPermission()}>
          允许系统通知
        </Button>
      ) : null}
      {anyEnabled && permission === "denied" ? (
        <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={() => void openSystemSettings()}>
          打开系统通知设置
        </Button>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
