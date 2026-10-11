import { useEffect, useState } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronRight } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import type { PluginConfig, PluginAccountSupport, PluginLink } from "@/lib/plugin-types"
import { getProviderConfig, type ProviderConfigView } from "@/lib/provider-config"
import { useAppUiStore } from "@/stores/app-ui-store"
import { cn } from "@/lib/utils"

export interface SettingsPluginConfig {
  id: string
  name: string
  enabled: boolean
  config?: PluginConfig
  accountSupport?: PluginAccountSupport
  links?: PluginLink[]
}

function DragHandle({
  attributes,
  listeners,
}: {
  attributes: ReturnType<typeof useSortable>["attributes"]
  listeners: ReturnType<typeof useSortable>["listeners"]
}) {
  return (
    <button
      type="button"
      aria-label="拖拽排序"
      onClick={(event) => event.stopPropagation()}
      className="touch-none cursor-grab text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <span aria-hidden className="grid h-4 w-4 grid-cols-2 gap-0.5 p-0.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <span key={index} className="h-1 w-1 rounded-full bg-current" />
        ))}
      </span>
    </button>
  )
}


export function SortablePluginItem({ plugin, onToggle }: {
  plugin: SettingsPluginConfig
  onToggle: (id: string) => void
  onProviderConfigSaved?: (id: string) => Promise<void>
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: plugin.id })
  const openConnection = useAppUiStore((state) => state.openConnection)
  const [view, setView] = useState<ProviderConfigView | null>(null)
  const [failed, setFailed] = useState(false)
  const hasConfig = Boolean(plugin.config?.fields.length)
  useEffect(() => {
    let cancelled = false
    if (hasConfig) getProviderConfig(plugin.id).then((next) => { if (!cancelled) setView(next) }).catch((err) => {
      console.error("Failed to load provider config summary:", err)
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [hasConfig, plugin.id])
  const saved = (view?.storedFields?.length ?? 0) > 0 || Object.values(view?.values ?? {}).some((value) => value.type === "secret" && value.configured)
  const detected = plugin.config?.fields.some((field) => field.type === "secret" && view?.environment?.[field.id]?.configured)
  const label = failed ? "无法读取" : saved ? "已保存" : detected ? "已发现凭据" : "连接"
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("rounded-md border border-transparent bg-card", isDragging && "border-border opacity-50")}>
    <div className="flex min-h-10 items-center gap-3 px-3 py-2">
      <DragHandle attributes={attributes} listeners={listeners} />
      <button type="button" aria-label={`连接 ${plugin.name}`} onClick={() => openConnection(plugin.id, hasConfig ? "config" : plugin.accountSupport ? "accounts" : "local")} className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]", !plugin.enabled && "text-muted-foreground")}>
        <span className="min-w-0 flex-1 truncate text-sm">{plugin.name}</span>
        <span className={cn("shrink-0 text-[10px] text-muted-foreground", failed && "text-destructive")}>{label}</span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Checkbox aria-label={`${plugin.enabled ? "停用" : "启用"} ${plugin.name}`} checked={plugin.enabled} onCheckedChange={() => onToggle(plugin.id)} />
    </div>
  </div>
}
