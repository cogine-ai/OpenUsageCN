import { useEffect, useMemo, useState } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { ProviderConfigFields } from "@/components/provider-config-fields"
import type { PluginConfig as ManifestPluginConfig, PluginConfigField } from "@/lib/plugin-types"
import { getProviderConfig, type ProviderConfigView, type ProviderConfigViewValue } from "@/lib/provider-config"
import { cn } from "@/lib/utils"

export interface SettingsPluginConfig {
  id: string
  name: string
  enabled: boolean
  config?: ManifestPluginConfig
}

type ConfigStatusKind = "configured" | "default" | "empty" | "unknown"

type ConfigStatus = {
  kind: ConfigStatusKind
  label: string
  className: string
}

const EMPTY_FIELDS: PluginConfigField[] = []

const CONFIG_STATUS: Record<ConfigStatusKind, ConfigStatus> = {
  configured: {
    kind: "configured",
    label: "已配置",
    className: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  },
  default: {
    kind: "default",
    label: "使用默认",
    className: "border-border bg-muted text-muted-foreground",
  },
  empty: {
    kind: "empty",
    label: "未配置",
    className: "border-border bg-background text-muted-foreground",
  },
  unknown: {
    kind: "unknown",
    label: "配置未知",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function hasDefaultSource(field: PluginConfigField): boolean {
  if (field.default !== undefined && field.default !== null) {
    return true
  }
  if (field.type === "select" && field.options.length > 0) {
    return true
  }
  return /环境变量|environment variable|env var/i.test(field.help ?? "")
}

function hasConfiguredValue(field: PluginConfigField, value: ProviderConfigViewValue | undefined): boolean {
  if (!value) return false
  if (value.type === "secret") {
    return value.configured
  }
  if (value.type === "text") {
    return hasText(value.value)
  }
  if (value.type === "select") {
    const defaultValue = typeof field.default === "string" ? field.default : field.options[0]?.value
    return hasText(value.value) && value.value !== defaultValue
  }
  if (value.type === "toggle") {
    return value.value !== Boolean(field.default)
  }
  return false
}

function getConfigStatus(fields: PluginConfigField[], view: ProviderConfigView | null, failed: boolean): ConfigStatus {
  if (failed) return CONFIG_STATUS.unknown
  if (view && fields.some((field) => hasConfiguredValue(field, view.values[field.id]))) {
    return CONFIG_STATUS.configured
  }
  if (fields.some(hasDefaultSource)) {
    return CONFIG_STATUS.default
  }
  return CONFIG_STATUS.empty
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

export function SortablePluginItem({
  plugin,
  onToggle,
  onProviderConfigSaved,
}: {
  plugin: SettingsPluginConfig
  onToggle: (id: string) => void
  onProviderConfigSaved: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [configView, setConfigView] = useState<ProviderConfigView | null>(null)
  const [configLoadFailed, setConfigLoadFailed] = useState(false)
  const [summaryVersion, setSummaryVersion] = useState(0)
  const fields = plugin.config?.fields ?? EMPTY_FIELDS
  const hasConfigFields = fields.length > 0
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: plugin.id })

  useEffect(() => {
    if (!hasConfigFields) {
      setConfigView(null)
      setConfigLoadFailed(false)
      setExpanded(false)
      return
    }

    let cancelled = false
    setConfigLoadFailed(false)
    getProviderConfig(plugin.id)
      .then((nextView) => {
        if (cancelled) return
        setConfigView(nextView)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("Failed to load provider config summary:", err)
        setConfigView(null)
        setConfigLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [fields, hasConfigFields, plugin.id, summaryVersion])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const configStatus = useMemo(
    () => getConfigStatus(fields, configView, configLoadFailed),
    [configLoadFailed, configView, fields]
  )

  const handleConfigSaved = (pluginId: string) => {
    setSummaryVersion((current) => current + 1)
    onProviderConfigSaved(pluginId)
  }

  const titleClassName = cn(
    "min-w-0 flex-1 truncate text-left text-sm",
    !plugin.enabled && "text-muted-foreground"
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-md border border-transparent bg-card",
        isDragging && "border-border opacity-50"
      )}
    >
      <div className="flex min-h-10 items-center gap-3 px-3 py-2">
        <DragHandle attributes={attributes} listeners={listeners} />

        {hasConfigFields ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${plugin.name} 配置`}
            onClick={() => setExpanded((current) => !current)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none",
              "focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            )}
          >
            <span className={titleClassName}>{plugin.name}</span>
            {!expanded ? (
              <span
                className={cn(
                  "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                  configStatus.className
                )}
              >
                {configStatus.label}
              </span>
            ) : null}
            {expanded ? (
              <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className={titleClassName}>{plugin.name}</span>
        )}

        <span
          className="flex h-8 w-12 shrink-0 items-center justify-center"
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            aria-label={`${plugin.enabled ? "停用" : "启用"} ${plugin.name}`}
            key={`${plugin.id}-${plugin.enabled}`}
            checked={plugin.enabled}
            onCheckedChange={() => onToggle(plugin.id)}
            className="after:-inset-x-4 after:-inset-y-3"
          />
        </span>
      </div>

      {hasConfigFields && expanded ? (
        <div
          className="px-3 pb-3"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ProviderConfigFields
            pluginId={plugin.id}
            fields={fields}
            onSaved={handleConfigSaved}
          />
        </div>
      ) : null}
    </div>
  )
}
