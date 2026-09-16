import { useRef, useState } from "react"
import { Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ProviderAccountSummary } from "@/lib/plugin-types"

type RemoveAccountButtonProps = {
  account: ProviderAccountSummary
  active: boolean
  busy: boolean
  onRemove: () => Promise<boolean>
}

export function RemoveAccountButton({ account, active, busy, onRemove }: RemoveAccountButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={triggerRef}
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`移除 ${account.label}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-4" />
            </Button>
          }
        />
        <TooltipContent>移除 {account.label}</TooltipContent>
      </Tooltip>
      {confirming ? (
        <div role="group" aria-label={`确认移除 ${account.label}`} className="basis-full rounded-md border border-border p-2">
          <p className="text-xs text-muted-foreground">
            移除 {account.label} 的所有连接和本地缓存。不会退出外部应用。
          </p>
          {active ? (
            <p className="mt-1 text-xs text-muted-foreground">
              移除后自动跟随剩余本机默认连接；没有可用连接时显示未连接。
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              autoFocus
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                triggerRef.current?.focus()
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void onRemove().then((succeeded) => {
                  if (succeeded) setConfirming(false)
                })
              }}
            >
              确认移除
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
