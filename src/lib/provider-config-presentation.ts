import type { PluginConfigField } from "@/lib/plugin-types"
import type { ProviderConfigView } from "@/lib/provider-config"

export function configDraft(fields: PluginConfigField[], view: ProviderConfigView | null): Record<string, string | boolean> {
  return Object.fromEntries(fields.map((field) => {
    const saved = view?.values[field.id]
    return [field.id, field.type === "secret" ? "" : saved && "value" in saved ? saved.value ?? "" :
      field.type === "toggle" ? Boolean(field.default) : typeof field.default === "string" ? field.default : field.options[0]?.value ?? ""]
  }))
}

export function effectiveSelections(fields: PluginConfigField[], draft: Record<string, string | boolean>, view: ProviderConfigView | null): Record<string, string> {
  return Object.fromEntries(fields.filter((field) => field.type === "select").map((field) => {
    const value = String(draft[field.id] ?? "")
    if (value !== field.autoValue) return [field.id, value]
    const env = view?.environment?.[field.id]?.value
    if (env && field.options.some((option) => option.value === env && option.value !== field.autoValue)) return [field.id, env]
    if (field.environmentVariables?.some((name) => view?.environmentUnresolved?.includes(name))) return [field.id, ""]
    if (field.environmentVariables?.length && view?.environment?.[field.id]?.configured) return [field.id, ""]
    const credential = field.environmentVariables?.length ? undefined : fields.find((candidate) => {
      if (candidate.visibleWhen?.field !== field.id) return false
      const saved = view?.values[candidate.id]
      return (typeof draft[candidate.id] === "string" && String(draft[candidate.id]).trim().length > 0) || (saved?.type === "secret" && saved.configured) || view?.environment?.[candidate.id]?.configured
    })
    return [field.id, credential?.visibleWhen?.values[0] ?? field.options.find((option) => option.value !== field.autoValue)?.value ?? value]
  }))
}

export function visibleConfigFields(fields: PluginConfigField[], selections: Record<string, string>): PluginConfigField[] {
  return fields.filter((field) => !field.visibleWhen || field.visibleWhen.values.includes(selections[field.visibleWhen.field]))
}
