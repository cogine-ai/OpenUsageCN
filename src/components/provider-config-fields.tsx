import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { PluginConfigField } from "@/lib/plugin-types"
import {
  deleteProviderConfigField,
  getProviderConfig,
  saveProviderConfig,
  type ProviderConfigInput,
  type ProviderConfigView,
} from "@/lib/provider-config"
import { cn } from "@/lib/utils"

type DraftValues = Record<string, string | boolean>

type ProviderConfigFieldsProps = {
  pluginId: string
  fields: PluginConfigField[]
  onSaved: (pluginId: string) => void
}

function initialDraft(fields: PluginConfigField[], view: ProviderConfigView | null): DraftValues {
  const values: DraftValues = {}
  for (const field of fields) {
    const saved = view?.values[field.id]
    if (field.type === "secret") {
      values[field.id] = ""
      continue
    }
    if (field.type === "toggle") {
      values[field.id] = saved?.type === "toggle" ? saved.value : Boolean(field.default)
      continue
    }
    if (field.type === "select") {
      values[field.id] =
        saved?.type === "select"
          ? saved.value
          : typeof field.default === "string"
            ? field.default
            : field.options[0]?.value ?? ""
      continue
    }
    values[field.id] =
      saved?.type === "text"
        ? saved.value ?? ""
        : typeof field.default === "string"
          ? field.default
          : ""
  }
  return values
}

function secretPlaceholder(field: PluginConfigField, view: ProviderConfigView | null): string {
  const saved = view?.values[field.id]
  if (saved?.type === "secret" && saved.configured) {
    return saved.hint ? `已配置 ${saved.hint}` : "已配置"
  }
  return field.placeholder ?? ""
}

export function ProviderConfigFields({
  pluginId,
  fields,
  onSaved,
}: ProviderConfigFieldsProps) {
  const [view, setView] = useState<ProviderConfigView | null>(null)
  const [draft, setDraft] = useState<DraftValues>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getProviderConfig(pluginId)
      .then((nextView) => {
        if (cancelled) return
        setView(nextView)
        setDraft(initialDraft(fields, nextView))
      })
      .catch((err) => {
        if (cancelled) return
        console.error("Failed to load provider config:", err)
        setError("无法加载配置")
        setDraft(initialDraft(fields, null))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fields, pluginId])

  const canSave = useMemo(() => fields.length > 0 && !loading && !saving, [fields, loading, saving])

  const handleSave = async () => {
    const values: ProviderConfigInput = {}
    for (const field of fields) {
      const value = draft[field.id]
      if (typeof value === "boolean") {
        values[field.id] = value
      } else {
        values[field.id] = value ?? ""
      }
    }

    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      await saveProviderConfig(pluginId, values)
      const nextView = await getProviderConfig(pluginId)
      setView(nextView)
      setDraft(initialDraft(fields, nextView))
      setStatus("已保存，正在刷新")
      onSaved(pluginId)
    } catch (err) {
      console.error("Failed to save provider config:", err)
      setError("保存失败")
    } finally {
      setSaving(false)
    }
  }

  const handleClearSecret = async (fieldId: string) => {
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      await deleteProviderConfigField(pluginId, fieldId)
      const nextView = await getProviderConfig(pluginId)
      setView(nextView)
      setDraft(initialDraft(fields, nextView))
      setStatus("已清除，正在刷新")
      onSaved(pluginId)
    } catch (err) {
      console.error("Failed to clear provider config field:", err)
      setError("清除失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border bg-background p-3">
      {fields.map((field) => {
        const inputId = `${pluginId}-${field.id}`
        const saved = view?.values[field.id]
        return (
          <div key={field.id} className="space-y-1.5">
            <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
              {field.label}
            </label>
            {field.type === "secret" ? (
              <div className="flex gap-2">
                <input
                  id={inputId}
                  type="password"
                  value={String(draft[field.id] ?? "")}
                  placeholder={secretPlaceholder(field, view)}
                  disabled={loading || saving}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none",
                    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                />
                {saved?.type === "secret" && saved.configured ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => handleClearSecret(field.id)}
                  >
                    清除
                  </Button>
                ) : null}
              </div>
            ) : null}
            {field.type === "text" ? (
              <input
                id={inputId}
                type="text"
                value={String(draft[field.id] ?? "")}
                placeholder={field.placeholder}
                disabled={loading || saving}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field.id]: event.target.value }))
                }
                className={cn(
                  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
              />
            ) : null}
            {field.type === "select" ? (
              <select
                id={inputId}
                value={String(draft[field.id] ?? "")}
                disabled={loading || saving}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field.id]: event.target.value }))
                }
                className={cn(
                  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
            {field.type === "toggle" ? (
              <div className="flex h-8 items-center">
                <Checkbox
                  id={inputId}
                  checked={Boolean(draft[field.id])}
                  disabled={loading || saving}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({ ...current, [field.id]: checked === true }))
                  }
                />
              </div>
            ) : null}
            {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
          </div>
        )
      })}
      <div className="flex items-center justify-between gap-3">
        <div className="min-h-4 text-xs">
          {error ? <span className="text-destructive">{error}</span> : null}
          {!error && status ? <span className="text-muted-foreground">{status}</span> : null}
        </div>
        <Button type="button" size="sm" disabled={!canSave} onClick={handleSave}>
          {saving ? "保存中" : "保存"}
        </Button>
      </div>
    </div>
  )
}
